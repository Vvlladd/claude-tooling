# local-proxy

Tiny Anthropic-Messages → OpenAI-Chat-Completions shim so Claude Code can route selected requests to a local model (LM Studio, Ollama, vLLM, etc.) while leaving tool-using requests on Anthropic.

**Scope:** text-only requests. Requests containing `tools` always fall through to Anthropic. This keeps the proxy to ~200 lines and avoids the tool_use ↔ tool_calls translation rabbit hole.

## Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`). Node/npm won't work — this project targets Bun.
- **[LM Studio](https://lmstudio.ai)** (or any OpenAI-compatible local server: Ollama, vLLM, llama.cpp). Download a coder-grade model — Qwen2.5-Coder-32B, DeepSeek-Coder-V2, etc.
- **[Claude Code](https://docs.claude.com/en/docs/claude-code/overview)** CLI installed and authenticated (`claude` on your PATH).

## First-time setup

### 1. Clone and install

```bash
git clone https://github.com/Vvlladd/claude-tooling
cd claude-tooling/local-proxy
bun install
```

### 2. Start LM Studio's API server

Open LM Studio → **Discover** tab → download a model.
Switch to the **Developer** tab → load the model → toggle **Status: Running**.
Verify:

```bash
curl http://127.0.0.1:1234/v1/models
```

You should see the loaded model listed.

> Tip: in **Load → Advanced**, set **Parallel = 1** for Qwen/Gemma models. Higher values cause streaming to cut off mid-response.

### 3. Create your `.env`

```bash
cp .env.example .env
```

Edit `.env` — the defaults work, but at minimum set the model you loaded:

```bash
LMSTUDIO_MODEL=qwen2.5-coder-32b-instruct
ROUTE_HAIKU_LOCAL=1    # send haiku traffic (compaction, titles) to local
DEBUG=1                # log one line per request (recommended first time)
```

Leave `ANTHROPIC_API_KEY` empty — Claude Code sends its own `x-api-key` header with every request.

### 4. Run the proxy

```bash
bun run start        # production
# or
bun run dev          # hot-reload on file change
```

You should see:

```
local-proxy listening on http://127.0.0.1:8787
  default → https://api.anthropic.com
  local   → http://127.0.0.1:1234 (model: qwen2.5-coder-32b-instruct)
  haiku-to-local: ON
  debug logging:  ON
```

Leave this terminal open.

### 5. Point Claude Code at the proxy

In a **new terminal**:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Use Claude Code normally. Tool-using turns still hit Anthropic; background haiku tasks route to LM Studio. With `DEBUG=1` you'll see each decision in the proxy terminal:

```
[proxy] POST claude-3-5-haiku-20241022 → lmstudio 200 412ms
[proxy] POST claude-sonnet-4-5 → anthropic 200 1823ms
```

### 6. Make it permanent (optional)

Add to your shell profile (`~/.zshrc`):

```bash
alias claude-local='ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude'
```

Then `claude-local` always runs through the proxy (when it's up).

## Routing rules

A request routes to LM Studio if **all** of:

1. It has no `tools` field (or empty array), AND
2. Either:
   - `model` starts with `local/` (e.g. `local/qwen2.5-coder-32b-instruct`), OR
   - `ROUTE_HAIKU_LOCAL=1` and `model` contains `haiku`

Everything else forwards to Anthropic unchanged.

## Request flow

```
  ┌──────────────┐   POST /v1/messages    ┌──────────────────────┐
  │ Claude Code  │  ────────────────────▶ │  local-proxy :8787   │
  │ (ANTHROPIC_  │   Anthropic format      │                      │
  │  BASE_URL)   │                         │   routeFor(req)      │
  └──────────────┘                         └───────────┬──────────┘
                                                       │
                           tools present?              │   no tools AND
                           or no route match           │   (local/* OR
                                                       │    haiku + flag)
                              ┌────────────────────────┴──────────┐
                              ▼                                   ▼
                  ┌──────────────────────┐           ┌──────────────────────┐
                  │  Anthropic API       │           │  LM Studio           │
                  │  forward as-is       │           │  /v1/chat/completions│
                  │  (body + headers)    │           │                      │
                  │                      │           │  translate request   │
                  │  stream/non-stream   │           │  OpenAI → Anthropic  │
                  │  passthrough         │           │  + SSE re-envelope   │
                  └──────────────────────┘           └──────────────────────┘
```

**Translation direction is one-way:** Anthropic Messages in → OpenAI Chat Completions out to LM Studio; OpenAI response/SSE back → Anthropic Messages/SSE to the client. Anthropic-path requests are not translated at all — the proxy just pipes bytes.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Proxy listen port |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Anthropic API base |
| `ANTHROPIC_API_KEY` | — | Used only if client omits `x-api-key` |
| `LMSTUDIO_URL` | `http://127.0.0.1:1234` | LM Studio OpenAI endpoint base |
| `LMSTUDIO_MODEL` | `qwen2.5-coder-32b-instruct` | Model name sent to LM Studio when using haiku-route |
| `LMSTUDIO_KEY` | `lm-studio` | Bearer token (LM Studio ignores value) |
| `ROUTE_HAIKU_LOCAL` | off | Set `1` to route any haiku-model request to LM Studio |
| `DEBUG` | off | Set `1` to log one line per request (`model → target status duration`) |

## Verify it works

```bash
# Health
curl http://127.0.0.1:8787/health

# Non-streaming, local route
curl -s http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: dummy' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "local/qwen2.5-coder-32b-instruct",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "Say hi in 3 words."}]
  }' | jq

# Streaming, local route
curl -N http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: dummy' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "local/qwen2.5-coder-32b-instruct",
    "max_tokens": 128,
    "stream": true,
    "messages": [{"role": "user", "content": "Count to 5."}]
  }'
```

## Known limitations

- No tool-use translation. Tool requests bypass LM Studio entirely.
- No image/vision support on the local path.
- System prompt content blocks flattened to text. Cache-control hints dropped on the local path (LM Studio doesn't cache like Anthropic).
- Token counts on the local path reflect LM Studio's tokenizer, not Claude's.
- If LM Studio returns `finish_reason: "tool_calls"` it's mapped to `end_turn` (shouldn't happen in the supported flow since we block tool requests upstream).

## Troubleshooting

**`ECONNREFUSED 127.0.0.1:1234`**
LM Studio API server isn't running. Open LM Studio → Developer tab → toggle *Status: Running*. Confirm with `curl http://127.0.0.1:1234/v1/models`.

**`404` or `400 invalid model` from proxy when using `local/<name>`**
Request probably contained `tools`, so the proxy fell through to Anthropic with an unrecognized model name. Either drop the `local/` prefix or remove tools from the request. Anthropic will reject any non-Anthropic model id.

**Streaming hangs or cuts off mid-response**
LM Studio's `Parallel` setting is too high for the Qwen/Gemma model's tool-use loop. Set `Parallel = 1` in LM Studio → Load → Advanced. Reduce `max_tokens` as a quick test.

**`401 unauthorized` on Anthropic path**
Client didn't send `x-api-key` and no `ANTHROPIC_API_KEY` env var is set. Either export it before launching the proxy or ensure Claude Code is authenticated.

**`context_length_exceeded` from LM Studio**
Conversation exceeds the local model's window (Qwen2.5-Coder = 32K, Gemma-4-26B varies by quant). Local path works best for short, stateless requests. Keep long threads on Anthropic.

**Gibberish or wrong-language output**
The loaded model handles the system prompt poorly. Try a stronger quant (Q5/Q6 instead of Q4), a different model, or reduce system prompt size. Some models need explicit `<|im_start|>` templating LM Studio normally applies — verify the model's chat template is set correctly in LM Studio.

**Proxy exits with `EADDRINUSE`**
Port 8787 already bound. Either set `PORT=8788` or kill the previous instance: `pkill -f 'bun run proxy.ts'`.

**Claude Code says "API Error 529 Overloaded" immediately**
This comes from Anthropic, not the proxy. Your request made it all the way through. Retry or switch to a less-loaded model.

**All requests go to Anthropic, never local**
Claude Code sends `tools` on almost every main-loop request — that's expected. Local routing fires for background/summarization tasks, which use fewer or no tools. Verify by watching LM Studio's Developer Logs while triggering `/compact` or letting a long session auto-compact.

## Next steps if you outgrow it

Point Claude Code at [`claude-code-router`](https://github.com/musistudio/claude-code-router) instead — it handles tool translation, multiple providers, and per-role routing out of the box.
