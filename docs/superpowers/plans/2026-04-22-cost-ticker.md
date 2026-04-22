# Cost Ticker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-memory per-session cost accumulator to `local-proxy` exposed at `GET /stats`, tracking real Anthropic spend (cache-aware) and estimated savings from local-routed requests.

**Architecture:** A pure `cost.ts` module holds the accumulator and pricing map. An `extract-usage.ts` helper uses `ReadableStream.tee()` to observe usage on the Anthropic byte-passthrough path without blocking the client. The local path instruments existing parsers directly (no tee needed). A new `GET /stats` route returns a snapshot.

**Tech Stack:** Bun (runtime + built-in test runner), Hono (HTTP), TypeScript. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-04-22-cost-ticker-design.md`](../specs/2026-04-22-cost-ticker-design.md)

---

## File Structure

**Create:**
- `local-proxy/cost.ts` — pure state + pricing. Exports `record`, `snapshot`, `priceFor`, `resetForTesting`, and the `Usage` / `StatsSnapshot` types.
- `local-proxy/extract-usage.ts` — tee-based helper for observing Anthropic usage. Exports `extractAnthropicUsage`.
- `local-proxy/cost.test.ts` — unit tests for pricing + accumulator.
- `local-proxy/extract-usage.test.ts` — unit tests for the tee helper.

**Modify:**
- `local-proxy/proxy.ts` — wire `cost.record` into local paths, wrap Anthropic response in `extractAnthropicUsage`, add `GET /stats` route.
- `local-proxy/package.json` — add `"test": "bun test"` script.
- `local-proxy/README.md` — add "Cost tracking" section with `/stats` schema and example.

---

## Task 1: Scaffold `cost.ts` with pricing map and `priceFor()`

**Files:**
- Create: `local-proxy/cost.ts`
- Create: `local-proxy/cost.test.ts`

- [ ] **Step 1: Write the failing tests for `priceFor`**

Create `local-proxy/cost.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { priceFor } from './cost'

describe('priceFor', () => {
  test('sonnet 4.5 input-only cost', () => {
    // 1000 input tokens × $3/M = $0.003
    const usd = priceFor('claude-sonnet-4-5-20250929', { input_tokens: 1000 })
    expect(usd).toBeCloseTo(0.003, 6)
  })

  test('sonnet 4.5 with cache read and cache creation', () => {
    // input: 1000 × 3/1M = 0.003
    // output: 500 × 15/1M = 0.0075
    // cache_read: 5000 × 0.3/1M = 0.0015
    // cache_creation: 2000 × 3.75/1M = 0.0075
    // total: 0.0195
    const usd = priceFor('claude-sonnet-4-5-20250929', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 2000,
    })
    expect(usd).toBeCloseTo(0.0195, 6)
  })

  test('prefix match: dated suffix resolves to base row', () => {
    const a = priceFor('claude-sonnet-4-5', { input_tokens: 1000 })
    const b = priceFor('claude-sonnet-4-5-20250929', { input_tokens: 1000 })
    expect(a).toBe(b)
    expect(a).toBeGreaterThan(0)
  })

  test('unknown model returns 0', () => {
    const usd = priceFor('claude-future-99', { input_tokens: 1000, output_tokens: 500 })
    expect(usd).toBe(0)
  })

  test('missing fields default to 0', () => {
    const usd = priceFor('claude-haiku-4-5-20251001', {})
    expect(usd).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd local-proxy && bun test cost.test.ts
```

Expected: fails with "Cannot find module './cost'" or equivalent.

- [ ] **Step 3: Implement `cost.ts` minimal version**

Create `local-proxy/cost.ts`:

```ts
export interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// USD per 1M tokens. Cache read = 0.1× input, cache creation = 1.25× input (Anthropic convention).
interface ModelRates {
  input: number
  output: number
  cache_read: number
  cache_creation: number
}

const PRICING: Record<string, ModelRates> = {
  'claude-opus-4-7':   { input: 15,   output: 75, cache_read: 1.5,  cache_creation: 18.75 },
  'claude-sonnet-4-6': { input:  3,   output: 15, cache_read: 0.3,  cache_creation:  3.75 },
  'claude-sonnet-4-5': { input:  3,   output: 15, cache_read: 0.3,  cache_creation:  3.75 },
  'claude-haiku-4-5':  { input:  1,   output:  5, cache_read: 0.1,  cache_creation:  1.25 },
  'claude-3-5-haiku':  { input:  0.8, output:  4, cache_read: 0.08, cache_creation:  1.0  },
}

function ratesFor(model: string): ModelRates | undefined {
  for (const prefix of Object.keys(PRICING)) {
    if (model.startsWith(prefix)) return PRICING[prefix]
  }
  return undefined
}

export function priceFor(model: string, usage: Usage): number {
  const r = ratesFor(model)
  if (!r) return 0
  const input = (usage.input_tokens ?? 0) * r.input
  const output = (usage.output_tokens ?? 0) * r.output
  const cacheRead = (usage.cache_read_input_tokens ?? 0) * r.cache_read
  const cacheCreate = (usage.cache_creation_input_tokens ?? 0) * r.cache_creation
  return (input + output + cacheRead + cacheCreate) / 1_000_000
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd local-proxy && bun test cost.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add local-proxy/cost.ts local-proxy/cost.test.ts
git commit -m "Add cost.ts pricing map and priceFor() with tests"
```

---

## Task 2: Add `record()` + `snapshot()` to `cost.ts`

**Files:**
- Modify: `local-proxy/cost.ts`
- Modify: `local-proxy/cost.test.ts`

- [ ] **Step 1: Add failing tests for record/snapshot**

Append to `local-proxy/cost.test.ts`:

```ts
import { record, snapshot, resetForTesting } from './cost'
import { beforeEach } from 'bun:test'

describe('record / snapshot', () => {
  beforeEach(() => resetForTesting())

  test('records an anthropic request', () => {
    record('anthropic', 'claude-sonnet-4-5-20250929', {
      input_tokens: 1000,
      output_tokens: 500,
    })
    const s = snapshot()
    expect(s.totals.requests.anthropic).toBe(1)
    expect(s.totals.requests.local).toBe(0)
    expect(s.totals.anthropic_usd).toBeCloseTo(0.0105, 6)
    expect(s.totals.local_saved_usd_est).toBe(0)
  })

  test('records a local request and estimates savings at haiku rates', () => {
    record('local', 'qwen2.5-coder-32b-instruct', {
      input_tokens: 1000,
      output_tokens: 500,
    })
    const s = snapshot()
    expect(s.totals.requests.local).toBe(1)
    expect(s.totals.requests.anthropic).toBe(0)
    // haiku-4-5: 1000×1/1M + 500×5/1M = 0.001 + 0.0025 = 0.0035
    expect(s.totals.local_saved_usd_est).toBeCloseTo(0.0035, 6)
    expect(s.totals.anthropic_usd).toBe(0)
  })

  test('aggregates multiple requests to the same model', () => {
    record('anthropic', 'claude-sonnet-4-5-20250929', { input_tokens: 1000 })
    record('anthropic', 'claude-sonnet-4-5-20250929', { input_tokens: 500 })
    const s = snapshot()
    const row = s.per_model['claude-sonnet-4-5-20250929']
    expect(row.requests).toBe(2)
    expect(row.input_tokens).toBe(1500)
  })

  test('keeps separate rows per model', () => {
    record('anthropic', 'claude-sonnet-4-5-20250929', { input_tokens: 100 })
    record('anthropic', 'claude-haiku-4-5-20251001', { input_tokens: 100 })
    const s = snapshot()
    expect(Object.keys(s.per_model)).toHaveLength(2)
  })

  test('snapshot includes session metadata', () => {
    const s = snapshot()
    expect(typeof s.session.started_at).toBe('string')
    expect(typeof s.session.uptime_ms).toBe('number')
    expect(s.session.uptime_ms).toBeGreaterThanOrEqual(0)
  })

  test('resetForTesting clears all state', () => {
    record('anthropic', 'claude-sonnet-4-5-20250929', { input_tokens: 1000 })
    resetForTesting()
    const s = snapshot()
    expect(s.totals.requests.anthropic).toBe(0)
    expect(Object.keys(s.per_model)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd local-proxy && bun test cost.test.ts
```

Expected: 5 original tests pass; new tests fail with "record is not exported" or similar.

- [ ] **Step 3: Implement record/snapshot in `cost.ts`**

Append to `local-proxy/cost.ts`:

```ts
export interface PerModelEntry {
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  usd?: number
  usd_saved_est?: number
}

export interface StatsSnapshot {
  session: { started_at: string; uptime_ms: number }
  totals: {
    anthropic_usd: number
    local_saved_usd_est: number
    requests: { anthropic: number; local: number }
  }
  per_model: Record<string, PerModelEntry>
}

const LOCAL_COUNTERFACTUAL = 'claude-haiku-4-5'

interface Accum {
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
}

const makeAccum = (): Accum => ({
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
})

interface State {
  startedAt: number
  byModel: Map<string, { path: 'anthropic' | 'local'; accum: Accum }>
}

let state: State = { startedAt: Date.now(), byModel: new Map() }

export function record(path: 'anthropic' | 'local', model: string, usage: Usage): void {
  const key = path === 'local' ? `local/${model}` : model
  let row = state.byModel.get(key)
  if (!row) {
    row = { path, accum: makeAccum() }
    state.byModel.set(key, row)
  }
  row.accum.requests += 1
  row.accum.input_tokens += usage.input_tokens ?? 0
  row.accum.output_tokens += usage.output_tokens ?? 0
  row.accum.cache_read_tokens += usage.cache_read_input_tokens ?? 0
  row.accum.cache_creation_tokens += usage.cache_creation_input_tokens ?? 0
}

export function snapshot(): StatsSnapshot {
  const now = Date.now()
  const per_model: Record<string, PerModelEntry> = {}
  let anthropic_usd = 0
  let local_saved_usd_est = 0
  let anthropicReqs = 0
  let localReqs = 0

  for (const [key, { path, accum }] of state.byModel) {
    const usage: Usage = {
      input_tokens: accum.input_tokens,
      output_tokens: accum.output_tokens,
      cache_read_input_tokens: accum.cache_read_tokens,
      cache_creation_input_tokens: accum.cache_creation_tokens,
    }
    const entry: PerModelEntry = {
      requests: accum.requests,
      input_tokens: accum.input_tokens,
      output_tokens: accum.output_tokens,
      cache_read_tokens: accum.cache_read_tokens,
      cache_creation_tokens: accum.cache_creation_tokens,
    }
    if (path === 'anthropic') {
      const usd = priceFor(key, usage)
      entry.usd = usd
      anthropic_usd += usd
      anthropicReqs += accum.requests
    } else {
      const usd = priceFor(LOCAL_COUNTERFACTUAL, usage)
      entry.usd_saved_est = usd
      local_saved_usd_est += usd
      localReqs += accum.requests
    }
    per_model[key] = entry
  }

  return {
    session: {
      started_at: new Date(state.startedAt).toISOString(),
      uptime_ms: now - state.startedAt,
    },
    totals: {
      anthropic_usd,
      local_saved_usd_est,
      requests: { anthropic: anthropicReqs, local: localReqs },
    },
    per_model,
  }
}

export function resetForTesting(): void {
  state = { startedAt: Date.now(), byModel: new Map() }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd local-proxy && bun test cost.test.ts
```

Expected: all 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add local-proxy/cost.ts local-proxy/cost.test.ts
git commit -m "Add record/snapshot to cost.ts with per-model aggregation"
```

---

## Task 3: Non-streaming branch of `extractAnthropicUsage`

**Files:**
- Create: `local-proxy/extract-usage.ts`
- Create: `local-proxy/extract-usage.test.ts`

- [ ] **Step 1: Write failing tests for non-streaming parse**

Create `local-proxy/extract-usage.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { extractAnthropicUsage } from './extract-usage'
import type { Usage } from './cost'

// Utility: wait for a microtask/IO tick so the background parser runs.
const settle = () => new Promise(r => setTimeout(r, 20))

describe('extractAnthropicUsage — non-stream', () => {
  test('client branch is byte-identical to input', async () => {
    const body = JSON.stringify({ id: 'msg_1', usage: { input_tokens: 100, output_tokens: 50 } })
    const upstream = new Response(body, { status: 200 })
    const resp = extractAnthropicUsage(upstream, false, () => {})
    expect(await resp.text()).toBe(body)
  })

  test('callback fires with parsed usage', async () => {
    const body = JSON.stringify({
      id: 'msg_1',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
    })
    const upstream = new Response(body, { status: 200 })
    let captured: Usage | null = null
    const resp = extractAnthropicUsage(upstream, false, u => { captured = u })
    await resp.text()
    await settle()
    expect(captured).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    })
  })

  test('invalid JSON: no callback, no throw', async () => {
    const upstream = new Response('not json', { status: 200 })
    let called = false
    const resp = extractAnthropicUsage(upstream, false, () => { called = true })
    await resp.text()
    await settle()
    expect(called).toBe(false)
  })

  test('null body: no callback, no throw', async () => {
    const upstream = new Response(null, { status: 204 })
    let called = false
    const resp = extractAnthropicUsage(upstream, false, () => { called = true })
    await resp.text().catch(() => {})
    await settle()
    expect(called).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd local-proxy && bun test extract-usage.test.ts
```

Expected: fails with "Cannot find module './extract-usage'".

- [ ] **Step 3: Implement `extract-usage.ts` (non-stream only)**

Create `local-proxy/extract-usage.ts`:

```ts
import type { Usage } from './cost'

export function extractAnthropicUsage(
  response: Response,
  isStream: boolean,
  onUsage: (u: Usage) => void,
): Response {
  if (!response.body) return response

  const [clientBranch, accountingBranch] = response.body.tee()

  // Fire-and-forget background parse. Errors are swallowed.
  void parseBranch(accountingBranch, isStream, onUsage).catch(() => {})

  return new Response(clientBranch, {
    status: response.status,
    headers: response.headers,
  })
}

async function parseBranch(
  stream: ReadableStream<Uint8Array>,
  isStream: boolean,
  onUsage: (u: Usage) => void,
): Promise<void> {
  if (isStream) {
    // Implemented in Task 4.
    return
  }
  await parseJson(stream, onUsage)
}

async function parseJson(
  stream: ReadableStream<Uint8Array>,
  onUsage: (u: Usage) => void,
): Promise<void> {
  const text = await new Response(stream).text()
  const obj = JSON.parse(text)
  const u = obj?.usage
  if (!u || typeof u !== 'object') return
  onUsage({
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
  })
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd local-proxy && bun test extract-usage.test.ts
```

Expected: 4 non-stream tests pass.

- [ ] **Step 5: Commit**

```bash
git add local-proxy/extract-usage.ts local-proxy/extract-usage.test.ts
git commit -m "Add non-streaming branch of extractAnthropicUsage with tee"
```

---

## Task 4: Streaming branch of `extractAnthropicUsage`

**Files:**
- Modify: `local-proxy/extract-usage.ts`
- Modify: `local-proxy/extract-usage.test.ts`

- [ ] **Step 1: Add failing streaming tests**

Append to `local-proxy/extract-usage.test.ts`:

```ts
describe('extractAnthropicUsage — stream', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":50}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n')

  test('client branch is byte-identical for SSE', async () => {
    const upstream = new Response(sse, { status: 200 })
    const resp = extractAnthropicUsage(upstream, true, () => {})
    expect(await resp.text()).toBe(sse)
  })

  test('callback fires once with combined usage from message_start + message_delta', async () => {
    const upstream = new Response(sse, { status: 200 })
    let callCount = 0
    let captured: Usage | null = null
    const resp = extractAnthropicUsage(upstream, true, u => {
      callCount += 1
      captured = u
    })
    await resp.text()
    await settle()
    expect(callCount).toBe(1)
    expect(captured).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 200,
    })
  })

  test('malformed SSE chunks are skipped', async () => {
    const bad = [
      'event: message_start',
      'data: {not valid json',
      '',
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":42}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":7}}',
      '',
    ].join('\n')
    const upstream = new Response(bad, { status: 200 })
    let captured: Usage | null = null
    const resp = extractAnthropicUsage(upstream, true, u => { captured = u })
    await resp.text()
    await settle()
    expect(captured).toMatchObject({ input_tokens: 42, output_tokens: 7 })
  })

  test('no usage events: no callback, no throw', async () => {
    const noUsage = 'event: ping\ndata: {}\n\n'
    const upstream = new Response(noUsage, { status: 200 })
    let called = false
    const resp = extractAnthropicUsage(upstream, true, () => { called = true })
    await resp.text()
    await settle()
    expect(called).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd local-proxy && bun test extract-usage.test.ts
```

Expected: non-stream tests still pass; new stream tests fail (combined-usage test fails because stream branch is still a no-op).

- [ ] **Step 3: Implement streaming parser**

Replace the body of `parseBranch` and add `parseSse` in `local-proxy/extract-usage.ts`:

```ts
async function parseBranch(
  stream: ReadableStream<Uint8Array>,
  isStream: boolean,
  onUsage: (u: Usage) => void,
): Promise<void> {
  if (isStream) {
    await parseSse(stream, onUsage)
    return
  }
  await parseJson(stream, onUsage)
}

async function parseSse(
  stream: ReadableStream<Uint8Array>,
  onUsage: (u: Usage) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const acc: Usage = {}
  let sawAny = false

  const flush = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    try {
      const obj = JSON.parse(payload)
      const u = obj?.message?.usage ?? obj?.usage
      if (!u || typeof u !== 'object') return
      if (typeof u.input_tokens === 'number') acc.input_tokens = u.input_tokens
      if (typeof u.output_tokens === 'number') acc.output_tokens = u.output_tokens
      if (typeof u.cache_read_input_tokens === 'number') acc.cache_read_input_tokens = u.cache_read_input_tokens
      if (typeof u.cache_creation_input_tokens === 'number') acc.cache_creation_input_tokens = u.cache_creation_input_tokens
      sawAny = true
    } catch {
      // malformed chunk, skip
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) flush(line)
  }
  if (buffer) flush(buffer)

  if (sawAny) onUsage(acc)
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd local-proxy && bun test extract-usage.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add local-proxy/extract-usage.ts local-proxy/extract-usage.test.ts
git commit -m "Add streaming branch of extractAnthropicUsage with SSE parsing"
```

---

## Task 5: Add `GET /stats` endpoint to `proxy.ts`

**Files:**
- Modify: `local-proxy/proxy.ts`

- [ ] **Step 1: Read `proxy.ts` around the existing route registrations**

```bash
grep -n "app.get\|app.post" local-proxy/proxy.ts
```

You should see `app.get('/health', ...)` and `app.post('/v1/messages', ...)`.

- [ ] **Step 2: Add the import and the route**

Edit `local-proxy/proxy.ts` near the top of the file, after the `hono/streaming` import:

```ts
import { snapshot } from './cost'
```

Edit `local-proxy/proxy.ts` immediately after the line `app.get('/health', c => c.text('ok'))`:

```ts
app.get('/stats', c => c.json(snapshot()))
```

- [ ] **Step 3: Verify the server still starts**

```bash
cd local-proxy && bun run proxy.ts &
sleep 2
curl -s http://127.0.0.1:8787/stats | head -c 400
echo
curl -s http://127.0.0.1:8787/health
kill %1 2>/dev/null
```

Expected: `/stats` returns JSON with empty `per_model: {}`, totals all zero; `/health` returns `ok`.

- [ ] **Step 4: Commit**

```bash
git add local-proxy/proxy.ts
git commit -m "Expose cost snapshot at GET /stats"
```

---

## Task 6: Wire `cost.record` into local **non-streaming** path

**Files:**
- Modify: `local-proxy/proxy.ts`

- [ ] **Step 1: Find the local non-stream branch**

```bash
grep -n "openAIToAnthropic\|body.stream" local-proxy/proxy.ts
```

Look for the block that calls `upstream.json()` when `!body.stream`.

- [ ] **Step 2: Update the import**

Change the cost import to include `record`:

```ts
import { record as recordCost, snapshot } from './cost'
```

- [ ] **Step 3: Instrument the non-stream local branch**

In `local-proxy/proxy.ts`, find this block:

```ts
  if (!body.stream) {
    const data = await upstream.json()
    log(`POST ${body.model} → lmstudio ${upstream.status} ${Date.now() - start}ms`)
    return c.json(openAIToAnthropic(data, body.model))
  }
```

Replace with:

```ts
  if (!body.stream) {
    const data = await upstream.json() as {
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    recordCost('local', decision.localModel, {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    })
    log(`POST ${body.model} → lmstudio ${upstream.status} ${Date.now() - start}ms`)
    return c.json(openAIToAnthropic(data, body.model))
  }
```

- [ ] **Step 4: Smoke-test manually (no LM Studio required — use a fake)**

```bash
cd local-proxy
# Start a fake OpenAI-compatible server on :1234 that returns a canned response
bun -e '
  const s = Bun.serve({
    port: 1234,
    fetch() {
      return Response.json({
        id: "cmpl_1",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 123, completion_tokens: 45 },
      })
    },
  })
  console.log("fake on", s.port)
' &
FAKE=$!
sleep 1

bun run proxy.ts &
PROXY=$!
sleep 2

curl -s http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: dummy' \
  -d '{"model":"local/test","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}'
echo
curl -s http://127.0.0.1:8787/stats | head -c 500
echo

kill $PROXY $FAKE 2>/dev/null
```

Expected: `/stats` shows `per_model["local/test"]` with `requests: 1`, `input_tokens: 123`, `output_tokens: 45`, and `usd_saved_est > 0`.

- [ ] **Step 5: Commit**

```bash
git add local-proxy/proxy.ts
git commit -m "Record cost on local non-streaming path"
```

---

## Task 7: Wire `cost.record` into local **streaming** path

**Files:**
- Modify: `local-proxy/proxy.ts`

- [ ] **Step 1: Find the streaming local branch**

```bash
grep -n "content_block_stop\|stream ok" local-proxy/proxy.ts
```

Look for the block after the `while (true) { ... }` read loop where we write the terminal SSE events.

- [ ] **Step 2: Add `recordCost` call before final log**

In `local-proxy/proxy.ts`, find this block:

```ts
    await write('content_block_stop', { type: 'content_block_stop', index: 0 })
    await write('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    })
    await write('message_stop', { type: 'message_stop' })
    log(`POST ${body.model} → lmstudio stream ok ${Date.now() - start}ms in=${inputTokens} out=${outputTokens}`)
  })
```

Add the `recordCost` call just before the final `log`:

```ts
    await write('content_block_stop', { type: 'content_block_stop', index: 0 })
    await write('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    })
    await write('message_stop', { type: 'message_stop' })
    recordCost('local', decision.localModel, {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    })
    log(`POST ${body.model} → lmstudio stream ok ${Date.now() - start}ms in=${inputTokens} out=${outputTokens}`)
  })
```

Note: do NOT record when `aborted` is true — the early-return above it already short-circuits that case.

- [ ] **Step 3: Verify with build**

```bash
cd local-proxy && bun build --target=bun proxy.ts --outfile=/dev/null
```

Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add local-proxy/proxy.ts
git commit -m "Record cost on local streaming path"
```

---

## Task 8: Wire `extractAnthropicUsage` into the Anthropic passthrough

**Files:**
- Modify: `local-proxy/proxy.ts`

- [ ] **Step 1: Add the import**

Near the top of `local-proxy/proxy.ts`, alongside the existing imports:

```ts
import { extractAnthropicUsage } from './extract-usage'
```

- [ ] **Step 2: Wrap the Anthropic response**

In `local-proxy/proxy.ts`, find the Anthropic branch:

```ts
  if (decision.target === 'anthropic') {
    const upstream = await fetch(`${ANTHROPIC_API}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': c.req.header('x-api-key') ?? process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': c.req.header('anthropic-version') ?? '2023-06-01',
        ...(c.req.header('anthropic-beta') ? { 'anthropic-beta': c.req.header('anthropic-beta')! } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })
    log(`POST ${body.model} → anthropic ${upstream.status} ${Date.now() - start}ms`)
    const headers = new Headers(upstream.headers)
    for (const h of HOP_BY_HOP) headers.delete(h)
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    })
  }
```

Replace the `return new Response(...)` block at the end with:

```ts
    const headers = new Headers(upstream.headers)
    for (const h of HOP_BY_HOP) headers.delete(h)
    const observed = extractAnthropicUsage(upstream, body.stream ?? false, usage => {
      recordCost('anthropic', body.model, usage)
    })
    return new Response(observed.body, {
      status: upstream.status,
      headers,
    })
  }
```

- [ ] **Step 3: Smoke-test against a fake Anthropic**

```bash
cd local-proxy
bun -e '
  const s = Bun.serve({
    port: 19999,
    fetch() {
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 8000 },
      })
    },
  })
  console.log("fake anthropic on", s.port)
' &
FAKE=$!
sleep 1

ANTHROPIC_UPSTREAM=http://127.0.0.1:19999 bun run proxy.ts &
PROXY=$!
sleep 2

curl -s http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: sk-ant-dummy' \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}' \
  > /dev/null
sleep 1
curl -s http://127.0.0.1:8787/stats
echo

kill $PROXY $FAKE 2>/dev/null
```

Expected: `/stats` shows `per_model["claude-sonnet-4-5-20250929"]` with `requests: 1`, `input_tokens: 1000`, `output_tokens: 500`, `cache_read_tokens: 8000`, `usd: 0.0105` (1000×3 + 500×15 + 8000×0.3, all / 1M = 0.0105).

- [ ] **Step 4: Commit**

```bash
git add local-proxy/proxy.ts
git commit -m "Record cost on Anthropic passthrough via extractAnthropicUsage"
```

---

## Task 9: Add `test` script, run full test suite, update README

**Files:**
- Modify: `local-proxy/package.json`
- Modify: `local-proxy/README.md`

- [ ] **Step 1: Add test script**

Edit `local-proxy/package.json` — inside the `"scripts"` object, add:

```json
    "test": "bun test"
```

Resulting `"scripts"` block should be:

```json
  "scripts": {
    "start": "bun run proxy.ts",
    "dev": "bun --hot proxy.ts",
    "test": "bun test"
  },
```

- [ ] **Step 2: Run the full test suite**

```bash
cd local-proxy && bun test
```

Expected: all tests pass (19 total across the two test files: 11 in cost.test.ts, 8 in extract-usage.test.ts).

- [ ] **Step 3: Add "Cost tracking" section to README**

Edit `local-proxy/README.md` — add a new section immediately **before** the "Known limitations" section. Keep the exact heading and content:

````markdown
## Cost tracking

The proxy keeps a per-session running total of your Anthropic spend (cache-aware) and an estimate of what local-routed requests would have cost at haiku rates. Totals are in-memory and reset on restart.

Fetch them any time:

```bash
curl -s http://127.0.0.1:8787/stats | jq
```

Example response:

```json
{
  "session": { "started_at": "2026-04-22T10:23:11Z", "uptime_ms": 1320000 },
  "totals": {
    "anthropic_usd": 0.4231,
    "local_saved_usd_est": 1.182,
    "requests": { "anthropic": 94, "local": 48 }
  },
  "per_model": {
    "claude-sonnet-4-5-20250929": {
      "requests": 94,
      "input_tokens": 18420,
      "output_tokens": 3102,
      "cache_read_tokens": 214800,
      "cache_creation_tokens": 12800,
      "usd": 0.4231
    },
    "local/qwen2.5-coder-32b-instruct": {
      "requests": 48,
      "input_tokens": 28100,
      "output_tokens": 9240,
      "usd_saved_est": 1.182
    }
  }
}
```

- **`anthropic_usd`** — real spend on Anthropic-routed requests, using per-component pricing (input / output / cache_read / cache_creation).
- **`local_saved_usd_est`** — what those local requests would have cost at Claude haiku-4-5 rates. Deliberately conservative — the real counterfactual for a sonnet-grade task would be higher.
- Unknown model IDs record token counts but their `usd` is `0`.
- No persistence. If you need monthly totals, keep the proxy running or watch this endpoint externally.
````

- [ ] **Step 4: Verify everything still builds and tests pass**

```bash
cd local-proxy && bun build --target=bun proxy.ts --outfile=/dev/null && bun test
```

Expected: clean build, all 19 tests pass.

- [ ] **Step 5: Commit**

```bash
git add local-proxy/package.json local-proxy/README.md
git commit -m "Add test script and document /stats endpoint"
```

---

## Final verification (no commit)

- [ ] Run full suite: `cd local-proxy && bun test` — expect all green.
- [ ] Build check: `cd local-proxy && bun build --target=bun proxy.ts --outfile=/dev/null` — expect clean.
- [ ] Start proxy + curl `/stats`, `/health`, and `/v1/messages` with `local/` model against a real LM Studio (or a fake as in Task 6). Confirm `/stats` numbers move after each request.
- [ ] Confirm `git log --oneline` shows one commit per task (9 commits) on top of the spec commit.
