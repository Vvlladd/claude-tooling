export interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

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
