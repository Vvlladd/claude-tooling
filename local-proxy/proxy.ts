import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { snapshot } from './cost'

const ANTHROPIC_API = process.env.ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com'
const LMSTUDIO_API = process.env.LMSTUDIO_URL ?? 'http://127.0.0.1:1234'
const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL ?? 'qwen2.5-coder-32b-instruct'
const LMSTUDIO_KEY = process.env.LMSTUDIO_KEY ?? 'lm-studio'
const ROUTE_HAIKU_LOCAL = process.env.ROUTE_HAIKU_LOCAL === '1'
const LOCAL_PREFIX = 'local/'
const PORT = Number(process.env.PORT ?? 8787)
const DEBUG = process.env.DEBUG === '1'

const log = (...args: unknown[]) => {
  if (DEBUG) console.log('[proxy]', ...args)
}

const HOP_BY_HOP = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'] as const

interface AnthropicContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | AnthropicContentBlock[]
}

interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicContentBlock[]
  max_tokens: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: unknown[]
  tool_choice?: unknown
}

type RouteDecision =
  | { target: 'anthropic' }
  | { target: 'lmstudio'; localModel: string }

function routeFor(req: AnthropicRequest): RouteDecision {
  // Tool-use requests always go to Anthropic — translation is out of scope
  if (req.tools && req.tools.length > 0) return { target: 'anthropic' }

  if (req.model.startsWith(LOCAL_PREFIX)) {
    return { target: 'lmstudio', localModel: req.model.slice(LOCAL_PREFIX.length) }
  }
  if (ROUTE_HAIKU_LOCAL && req.model.includes('haiku')) {
    return { target: 'lmstudio', localModel: LMSTUDIO_MODEL }
  }
  return { target: 'anthropic' }
}

function flattenContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
}

function flattenSystem(sys: AnthropicRequest['system']): string | undefined {
  if (!sys) return undefined
  if (typeof sys === 'string') return sys
  return sys
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
}

function anthropicToOpenAI(req: AnthropicRequest, localModel: string) {
  const messages: Array<{ role: string; content: string }> = []
  const sys = flattenSystem(req.system)
  if (sys) messages.push({ role: 'system', content: sys })
  for (const m of req.messages) {
    messages.push({ role: m.role, content: flattenContent(m.content) })
  }
  const streaming = req.stream ?? false
  const out: Record<string, unknown> = {
    model: localModel,
    messages,
    max_tokens: req.max_tokens,
    stream: streaming,
  }
  if (req.temperature !== undefined) out.temperature = req.temperature
  if (req.top_p !== undefined) out.top_p = req.top_p
  if (req.stop_sequences !== undefined) out.stop = req.stop_sequences
  if (streaming) out.stream_options = { include_usage: true }
  return out
}

function mapFinishReason(r: string | null | undefined): 'end_turn' | 'max_tokens' | 'stop_sequence' {
  if (r === 'length') return 'max_tokens'
  if (r === 'stop' || r === 'eos') return 'end_turn'
  return 'end_turn'
}

function openAIToAnthropic(resp: any, originalModel: string) {
  const choice = resp.choices?.[0] ?? {}
  const text = choice.message?.content ?? ''
  return {
    id: resp.id ?? `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: originalModel,
    content: [{ type: 'text', text }],
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  }
}

const app = new Hono()

app.get('/health', c => c.text('ok'))
app.get('/stats', c => c.json(snapshot()))

app.post('/v1/messages', async c => {
  const body = (await c.req.json()) as AnthropicRequest
  const decision = routeFor(body)
  const signal = c.req.raw.signal
  const start = Date.now()

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

  // Local path
  const openaiReq = anthropicToOpenAI(body, decision.localModel)
  const upstream = await fetch(`${LMSTUDIO_API}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${LMSTUDIO_KEY}`,
    },
    body: JSON.stringify(openaiReq),
    signal,
  })

  if (!upstream.ok) {
    const text = await upstream.text()
    log(`POST ${body.model} → lmstudio ${upstream.status} ${Date.now() - start}ms (error)`)
    return c.json(
      { type: 'error', error: { type: 'upstream_error', message: `LM Studio ${upstream.status}: ${text}` } },
      upstream.status as any,
    )
  }

  if (!body.stream) {
    const data = await upstream.json()
    log(`POST ${body.model} → lmstudio ${upstream.status} ${Date.now() - start}ms`)
    return c.json(openAIToAnthropic(data, body.model))
  }

  // Streaming translation: OpenAI chat.completion.chunk → Anthropic SSE event stream
  return streamSSE(c, async stream => {
    const msgId = `msg_${crypto.randomUUID()}`

    const write = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) })

    await write('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    await write('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })

    const reader = upstream.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' = 'end_turn'
    let inputTokens = 0
    let outputTokens = 0
    let aborted = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]') continue

          try {
            const chunk = JSON.parse(payload)
            const delta = chunk.choices?.[0]?.delta?.content
            const finish = chunk.choices?.[0]?.finish_reason
            if (typeof delta === 'string' && delta.length > 0) {
              await write('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta },
              })
            }
            if (finish) stopReason = mapFinishReason(finish)
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? inputTokens
              outputTokens = chunk.usage.completion_tokens ?? outputTokens
            }
          } catch {
            // skip malformed chunk
          }
        }
      }
    } catch (err) {
      // Client disconnected — signal propagated, upstream fetch aborted.
      // Stop emitting SSE and exit cleanly.
      if ((err as Error)?.name === 'AbortError' || signal.aborted) {
        aborted = true
      } else {
        throw err
      }
    }

    if (aborted) {
      log(`POST ${body.model} → lmstudio stream aborted ${Date.now() - start}ms`)
      return
    }

    await write('content_block_stop', { type: 'content_block_stop', index: 0 })
    await write('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    })
    await write('message_stop', { type: 'message_stop' })
    log(`POST ${body.model} → lmstudio stream ok ${Date.now() - start}ms in=${inputTokens} out=${outputTokens}`)
  })
})

console.log(`local-proxy listening on http://127.0.0.1:${PORT}`)
console.log(`  default → ${ANTHROPIC_API}`)
console.log(`  local   → ${LMSTUDIO_API} (model: ${LMSTUDIO_MODEL})`)
console.log(`  haiku-to-local: ${ROUTE_HAIKU_LOCAL ? 'ON' : 'OFF'}`)
console.log(`  debug logging:  ${DEBUG ? 'ON' : 'OFF'}`)

export default { port: PORT, fetch: app.fetch }
