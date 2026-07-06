import { afterEach, describe, expect, it } from 'vitest'
import { mockLlmText, startMockLlmServer, type MockLlmServer } from '../e2e/helpers/mock-llm-server'

let server: MockLlmServer | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

describe('mock LLM server', () => {
  it('returns deterministic OpenAI chat completion responses', async () => {
    server = await startMockLlmServer()
    const res = await fetch(`${server.url}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }] }),
    })

    expect(res.ok).toBe(true)
    const json = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(json.choices[0]?.message.content).toBe(mockLlmText())
    expect(server.requests).toMatchObject([{ method: 'POST', path: '/v1/chat/completions' }])
  })

  it('streams deterministic OpenAI chat completion chunks', async () => {
    server = await startMockLlmServer()
    const res = await fetch(`${server.url}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    })

    expect(res.ok).toBe(true)
    const text = await res.text()
    expect(text).toContain(mockLlmText())
    expect(text).toContain('data: [DONE]')
  })

  it('returns deterministic OpenAI responses API responses', async () => {
    server = await startMockLlmServer()
    const res = await fetch(`${server.url}/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', input: 'hello' }),
    })

    expect(res.ok).toBe(true)
    const json = await res.json() as { output_text: string }
    expect(json.output_text).toBe(mockLlmText())
  })
})
