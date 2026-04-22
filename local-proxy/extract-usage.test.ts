import { describe, expect, test } from 'bun:test'
import { extractAnthropicUsage } from './extract-usage'
import type { Usage } from './cost'

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
