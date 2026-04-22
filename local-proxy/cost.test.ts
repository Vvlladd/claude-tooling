import { describe, expect, test } from 'bun:test'
import { priceFor } from './cost'
import { record, snapshot, resetForTesting } from './cost'
import { beforeEach } from 'bun:test'

describe('priceFor', () => {
  test('sonnet 4.5 input-only cost', () => {
    const usd = priceFor('claude-sonnet-4-5-20250929', { input_tokens: 1000 })
    expect(usd).toBeCloseTo(0.003, 6)
  })

  test('sonnet 4.5 with cache read and cache creation', () => {
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
