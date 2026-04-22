import { describe, expect, test } from 'bun:test'
import { priceFor } from './cost'

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
