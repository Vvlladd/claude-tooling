# local-proxy: built-in cost ticker

**Status:** Proposed
**Date:** 2026-04-22
**Owner:** Vlad

## Summary

Add a per-session cost accumulator to `local-proxy` and expose it at `GET /stats`. Tracks real Anthropic spend (with correct cache pricing) and estimated savings from local-routed requests. In-memory only, resets on proxy restart. No new dependencies, no timers, no persistence.

## Goals

- Glanceable answer to "how much am I spending right now" while the proxy runs.
- Accurate Anthropic cost accounting, including cache reads and cache writes.
- Estimate of savings from the LM Studio path using Anthropic haiku pricing as the counterfactual.
- Zero impact on request latency or on the existing byte-passthrough semantics.
- No new runtime dependencies — plain Bun + Hono.

## Non-goals

- No persistence to disk. Restarting the proxy resets totals.
- No budget enforcement / hard stops.
- No periodic stdout ticker (`setInterval`). The `/stats` endpoint is the only surface.
- No per-request append in logs.
- No admin UI.
- No history or time-series — a single running total per model.
- No token-count reconciliation across tokenizers. LM Studio's tokenizer ≠ Claude's; local "savings" are explicitly an estimate.

## Design decisions (from brainstorming)

1. **Surface = `GET /stats` only.** Picked for robustness and maintainability: no timer lifecycle, no log-spam, one endpoint is also the future UI/CLI surface.
2. **Scope = Anthropic (real cost) + local (estimated savings using haiku pricing).** Showing savings keeps the motivation for running the proxy visible.
3. **Cache-aware pricing.** Track `input`, `output`, `cache_read`, `cache_creation` as separate accumulators with per-component rates. Without this, displayed cost on an active Claude Code session would be 3–5× too high and the tool would not be trustworthy.
4. **Tee-based accounting for Anthropic path.** The handler teeing `upstream.body` preserves byte-passthrough and imposes zero first-byte latency. Buffer-then-forward was rejected because it would delay streaming UX.

## Architecture

### Module boundaries

Three pieces, each independently testable:

1. **`cost.ts`** — pure state + pricing. No I/O. Exports:
   - `record(path: 'anthropic' | 'local', model: string, usage: Usage): void`
   - `snapshot(): StatsSnapshot`
   - `resetForTesting(): void`
2. **`extract-usage.ts`** — stream helper for the **Anthropic path only**, where we currently byte-passthrough without parsing. Exports:
   - `extractAnthropicUsage(response: Response, isStream: boolean, onUsage: (u: Usage) => void): Response`
   - Returns a new `Response` whose body is one branch of `response.body.tee()`. Parses the other branch in the background (JSON for non-stream, SSE `message_start` + `message_delta` events for stream) and invokes `onUsage` exactly once per request. Swallows parse errors.
3. **`/v1/messages` handler** (in existing `proxy.ts`) —
   - **Anthropic path:** wraps upstream in `extractAnthropicUsage(...)` and calls `cost.record('anthropic', ...)` from the callback.
   - **Local path:** instruments the existing parsers (the `upstream.json()` call in the non-stream branch, and the SSE translator loop in the stream branch). Calls `cost.record('local', ...)` once per request with the token counts already available. No tee needed — we're already reading these bytes.
4. **`GET /stats` handler** — new route. Returns `cost.snapshot()` as JSON.

### Data flow

```
                        client
                          │
                          ▼
                    /v1/messages
                          │
                 ┌────────┴─────────┐
                 ▼                  ▼
          Anthropic path      Local (LM Studio) path
                 │                  │
          fetch upstream      fetch upstream
                 │                  │
                 ▼                  ▼
      extractAnthropicUsage    existing parser
      (tee: A→client,          (already reads body
       B→background parse)      for translation)
                 │                  │
                 │ onUsage(...)     │ cost.record(
                 ▼                  ▼   'local', model, usage)
               cost.record('anthropic', model, usage)
                             │
                             ▼
                   in-memory accumulator
                             │
                             ▼
       GET /stats ──► cost.snapshot() ──► JSON response
```

### Key invariant

The client-facing branch of the tee is returned synchronously. The accounting branch's consumption is fire-and-forget. Any error in the accounting branch (parse failure, malformed SSE) is logged via the existing `log()` helper and never affects the client response.

## Components

### `cost.ts`

```ts
export interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface PerModelState {
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
}

// Pricing in USD per 1M tokens.
interface ModelRates {
  input: number
  output: number
  cache_read: number       // typically 0.1 × input
  cache_creation: number   // typically 1.25 × input
}

const PRICING: Record<string, ModelRates> = {
  'claude-opus-4-7':         { input: 15, output: 75, cache_read: 1.5,  cache_creation: 18.75 },
  'claude-sonnet-4-6':       { input:  3, output: 15, cache_read: 0.3,  cache_creation:  3.75 },
  'claude-sonnet-4-5':       { input:  3, output: 15, cache_read: 0.3,  cache_creation:  3.75 },
  'claude-haiku-4-5':        { input:  1, output:  5, cache_read: 0.1,  cache_creation:  1.25 },
  'claude-3-5-haiku':        { input:  0.80, output: 4, cache_read: 0.08, cache_creation: 1.0 },
  // ...extendable. Unknown model → tokens recorded, cost = 0.
}

// haiku-4-5 used for local "savings" counterfactual.
const LOCAL_COUNTERFACTUAL = 'claude-haiku-4-5'

export function record(path: 'anthropic' | 'local', model: string, usage: Usage): void
export function snapshot(): StatsSnapshot
```

The pricing map uses model-ID *prefixes* for lookup (so a dated suffix like `claude-sonnet-4-5-20250929` resolves to the `claude-sonnet-4-5` row). Unknown prefix: tokens are recorded, `usd` is `0`, and a `DEBUG`-guarded log line fires once per unknown model.

### `extract-usage.ts`

Only used by the Anthropic path (the local path instruments existing parsers). Two branches:

- **Non-stream (`isStream=false`):** `await clonedResponse.json()`, pull `usage` from the root, call `onUsage` once.
- **Stream (`isStream=true`):** parse SSE line-by-line. `event: message_start`'s `message.usage` carries `input_tokens` + `cache_*`; each `event: message_delta`'s `usage` carries cumulative `output_tokens`. Combine and emit `onUsage` once when the stream ends (on `message_stop` or reader `done`).

The SSE line parser is small and independent of the streaming translator used for the local path — no shared helper needed for v1.

### `GET /stats` handler

```ts
app.get('/stats', c => c.json(cost.snapshot()))
```

Returns the JSON shape shown in the design summary — per-model breakdown plus aggregated totals and session metadata (`started_at`, `uptime_ms`).

### Pricing-map scope for v1

Only the current Anthropic models we expect Claude Code to route through the proxy (opus 4.7, sonnet 4.5 / 4.6, haiku 4.5, haiku 3.5). Adding more is one row each and requires no code changes.

## Error handling

- **Parse failure on accounting branch** — caught, `log()`-ed, skipped. Never propagates. Client response is unaffected.
- **Missing `usage` fields in response** — fields default to 0. Request still counts.
- **Unknown model ID** — tokens recorded, USD = 0, one debug log ("unknown model for pricing: X").
- **Malformed SSE chunk** — already skipped by existing parser; same behavior in accounting parser.
- **Tee consumer lags or stalls** — the accounting branch is backpressure-isolated from the client branch because the runtime buffers between them. Worst case: some stale data if the proxy is shut down mid-parse. Acceptable for in-memory, non-billing stats.

## Testing

Manual verification checklist (no CI for this repo yet):

1. **Unit: pricing math.** Given a known `Usage` and model, verify `record` + `snapshot` produce the expected `usd`. 4-5 cases covering cache-heavy, cache-free, mixed, unknown model.
2. **Unit: accumulator.** Record against two models, verify per-model rows and totals aggregate correctly.
3. **Integration: Anthropic non-streaming.** `curl` a real Anthropic request through the proxy, then `curl /stats`, verify the number is within 1 cent of Anthropic's dashboard.
4. **Integration: Anthropic streaming.** Same, with `"stream": true`. Verify usage captured from `message_delta`.
5. **Integration: local non-streaming and streaming.** Verify local counters increment and `usd_saved_est` is non-zero.
6. **Negative: unknown model.** Request with model `claude-future-5` — verify tokens recorded, usd = 0, no crash.
7. **Negative: malformed response.** Point `ANTHROPIC_UPSTREAM` at a dummy server that returns invalid JSON — verify client still receives the (bad) body, stats are unchanged, proxy doesn't crash.

Tests will live as a Bun test file (`proxy.test.ts`) since Bun has a built-in test runner. Only unit tests are committed; integration steps are documented in the README.

## Rollout

Single PR. Three file changes: new `cost.ts`, new `extract-usage.ts`, `proxy.ts` modifications to wire it in. README gets a "Cost tracking" section with the `/stats` schema and an example.

## Future work (explicitly deferred)

- **Periodic stdout ticker.** ~10 lines on top of `cost.snapshot()`. Add only if users ask for it.
- **Persistence to disk.** Append-only JSONL of `{ts, path, model, usage}` records. Enables monthly totals and budget gating.
- **Budget enforcer.** Once persistence exists, a `BUDGET_USD` env var that returns 429 past the threshold.
- **Admin UI.** HTML page at `/` showing live stats. Pairs well with Pillar 2 observability.
- **Pricing auto-refresh.** Fetch pricing from Anthropic's public pricing page on startup.

## Glossary

- **Usage** — the `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` object Anthropic returns.
- **Counterfactual** — the model we *pretend* a local request would have hit, for savings estimation. Fixed at haiku-4-5 for v1.
- **Tee** — `ReadableStream.tee()`, produces two independent streams from one source.
