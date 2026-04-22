import type { Usage } from './cost'

export function extractAnthropicUsage(
  response: Response,
  isStream: boolean,
  onUsage: (u: Usage) => void,
): Response {
  if (!response.body) return response

  const [clientBranch, accountingBranch] = response.body.tee()

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
