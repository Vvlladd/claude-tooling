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
