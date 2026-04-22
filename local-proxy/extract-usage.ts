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
