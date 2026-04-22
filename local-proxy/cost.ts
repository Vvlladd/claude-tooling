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

// Tracks unknown model IDs we've already warned about so one surprise
// doesn't become a log flood. Scoped to the module so resetForTesting
// clears it too (see below).
let loggedUnknown = new Set<string>()

function ratesFor(model: string): ModelRates | undefined {
  for (const prefix of Object.keys(PRICING)) {
    if (model.startsWith(prefix)) return PRICING[prefix]
  }
  if (process.env.DEBUG === '1' && !loggedUnknown.has(model)) {
    loggedUnknown.add(model)
    console.log('[proxy] unknown model for pricing:', model)
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
  loggedUnknown = new Set<string>()
}
