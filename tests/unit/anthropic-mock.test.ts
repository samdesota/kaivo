import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAnthropicMock, type MockHandle } from '../mocks/anthropic/server.js'

describe('anthropic mock', () => {
  let mock: MockHandle

  beforeEach(async () => {
    mock = await createAnthropicMock()
  })
  afterEach(async () => {
    await mock.close()
  })

  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${mock.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  it('serves /__health', async () => {
    const res = await fetch(`${mock.url}/__health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('returns scripted text for a non-streaming messages request', async () => {
    mock.setScript({ turns: [{ blocks: [{ type: 'text', text: 'hello world' }] }] })
    const res = await post('/v1/messages', { model: 'claude-3-5-sonnet', messages: [] })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.role).toBe('assistant')
    expect(json.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(json.stop_reason).toBe('end_turn')
    expect(json.id).toMatch(/^msg_/)
    expect(json.usage.output_tokens).toBeGreaterThan(0)
  })

  it('streams SSE events in Anthropic messages wire format', async () => {
    mock.setScript({
      turns: [{ blocks: [{ type: 'text', text: 'streaming reply here — several chunks' }] }],
    })
    const res = await post('/v1/messages', { model: 'c', messages: [], stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/event-stream/)
    const text = await res.text()
    expect(text).toMatch(/event: message_start[\s\S]*"type":"message_start"/)
    expect(text).toMatch(/event: content_block_start/)
    expect(text).toMatch(/"type":"text_delta"/)
    expect(text).toMatch(/event: content_block_stop/)
    expect(text).toMatch(/event: message_delta[\s\S]*"stop_reason":"end_turn"/)
    expect(text).toMatch(/event: message_stop/)
  })

  it('emits multiple text_delta events so the stream is observably chunked', async () => {
    const long = 'x'.repeat(80)
    mock.setScript({ turns: [{ blocks: [{ type: 'text', text: long }] }] })
    const res = await post('/v1/messages', { model: 'c', stream: true })
    const text = await res.text()
    const deltas = text.match(/"type":"text_delta"/g) ?? []
    expect(deltas.length).toBeGreaterThanOrEqual(4)
  })

  it('supports tool_use blocks with stop_reason=tool_use', async () => {
    mock.setScript({
      turns: [
        {
          blocks: [
            { type: 'text', text: 'running ls' },
            { type: 'tool_use', name: 'bash', input: { command: 'ls' } },
          ],
        },
      ],
    })
    const res = await post('/v1/messages', { model: 'c', messages: [] })
    const json = await res.json()
    expect(json.stop_reason).toBe('tool_use')
    expect(json.content).toHaveLength(2)
    expect(json.content[0]).toEqual({ type: 'text', text: 'running ls' })
    expect(json.content[1].type).toBe('tool_use')
    expect(json.content[1].name).toBe('bash')
    expect(json.content[1].input).toEqual({ command: 'ls' })
    expect(json.content[1].id).toMatch(/^toolu_/)
  })

  it('streams tool_use via content_block_start + input_json_delta', async () => {
    mock.setScript({
      turns: [
        {
          blocks: [{ type: 'tool_use', id: 'toolu_abc', name: 'bash', input: { command: 'pwd' } }],
        },
      ],
    })
    const res = await post('/v1/messages', { model: 'c', stream: true })
    const text = await res.text()
    expect(text).toMatch(/"type":"tool_use"/)
    expect(text).toMatch(/"id":"toolu_abc"/)
    expect(text).toMatch(/"name":"bash"/)
    expect(text).toMatch(/"type":"input_json_delta"/)
    expect(text).toMatch(/"partial_json":"\{\\"command\\":\\"pwd\\"\}"/)
    expect(text).toMatch(/"stop_reason":"tool_use"/)
  })

  it('plays scripted turns in order and falls back when exhausted', async () => {
    mock.setScript({
      turns: [
        { blocks: [{ type: 'text', text: 'first' }] },
        { blocks: [{ type: 'text', text: 'second' }] },
      ],
      fallback: { blocks: [{ type: 'text', text: 'after the script' }] },
    })
    const first = await (await post('/v1/messages', {})).json()
    const second = await (await post('/v1/messages', {})).json()
    const third = await (await post('/v1/messages', {})).json()
    expect(first.content[0].text).toBe('first')
    expect(second.content[0].text).toBe('second')
    expect(third.content[0].text).toBe('after the script')
  })

  it('uses a built-in fallback when no script is set', async () => {
    const res = await (await post('/v1/messages', {})).json()
    expect(res.content[0].text).toBe('done')
    expect(res.stop_reason).toBe('end_turn')
  })

  it('logs every request with headers and body for assertions', async () => {
    mock.setScript({ turns: [{ blocks: [{ type: 'text', text: 'ok' }] }] })
    await post(
      '/v1/messages',
      { model: 'claude-x', tools: [{ name: 'bash' }, { name: 'pty' }] },
      { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' },
    )
    const reqs = mock.getRequests()
    expect(reqs).toHaveLength(1)
    const [req] = reqs
    if (!req) throw new Error('expected a request')
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/v1/messages')
    expect(req.headers['x-api-key']).toBe('test-key')
    expect(req.headers['anthropic-version']).toBe('2023-06-01')
    const body = req.body as { tools: Array<{ name: string }> }
    expect(body.tools.map((t) => t.name)).toEqual(['bash', 'pty'])
  })

  it('does not log control-plane calls in getRequests()', async () => {
    await fetch(`${mock.url}/__script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turns: [] }),
    })
    await fetch(`${mock.url}/__requests`)
    expect(mock.getRequests()).toEqual([])
  })

  it('supports HTTP control of script and requests', async () => {
    const set = await fetch(`${mock.url}/__script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turns: [{ blocks: [{ type: 'text', text: 'via http' }] }] }),
    })
    expect(set.status).toBe(200)
    expect((await set.json()).ok).toBe(true)

    const msg = await (await post('/v1/messages', {})).json()
    expect(msg.content[0].text).toBe('via http')

    const reqs = await (await fetch(`${mock.url}/__requests`)).json()
    expect(reqs).toHaveLength(1)
    expect(reqs[0].url).toBe('/v1/messages')

    const reset = await fetch(`${mock.url}/__reset`, { method: 'POST' })
    expect(reset.status).toBe(200)
    expect(mock.getRequests()).toEqual([])
  })

  it('reset() clears script and request log', async () => {
    mock.setScript({ turns: [{ blocks: [{ type: 'text', text: 'x' }] }] })
    await post('/v1/messages', {})
    expect(mock.getRequests()).toHaveLength(1)
    mock.reset()
    expect(mock.getRequests()).toEqual([])
    const r = await (await post('/v1/messages', {})).json()
    expect(r.content[0].text).toBe('done')
  })

  it('pushTurn() appends without losing prior turns', async () => {
    mock.setScript({ turns: [{ blocks: [{ type: 'text', text: 'a' }] }] })
    mock.pushTurn({ blocks: [{ type: 'text', text: 'b' }] })
    const first = await (await post('/v1/messages', {})).json()
    const second = await (await post('/v1/messages', {})).json()
    expect(first.content[0].text).toBe('a')
    expect(second.content[0].text).toBe('b')
  })

  it('rejects unknown paths with 404', async () => {
    const res = await fetch(`${mock.url}/nope`)
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error.type).toBe('not_found_error')
  })

  it('rejects invalid script body with 400', async () => {
    const res = await fetch(`${mock.url}/__script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  it('binds to a caller-requested port', async () => {
    const other = await createAnthropicMock({ port: 0 })
    try {
      expect(other.port).toBeGreaterThan(0)
      expect(other.url).toBe(`http://127.0.0.1:${other.port}`)
    } finally {
      await other.close()
    }
  })
})
