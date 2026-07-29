import { describe, expect, it, vi } from 'vitest'
import { OpenCodeWalkthroughModelRunner } from './opencode-model-runner.js'

vi.mock('../agent/opencode.js', () => ({
  opencodeBasicAuthHeader: (password: string) => `Basic ${password}`,
  opencodeSupervisor: { start: vi.fn() },
}))

function stream(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('OpenCode walkthrough model runner', () => {
  it('pins model settings, disables every discovered tool, streams deltas, and continues one private session', async () => {
    const promptAsync = vi.fn().mockResolvedValue({ data: undefined })
    const create = vi.fn().mockResolvedValue({ data: { id: 'private-1' } })
    const subscribe = vi.fn()
      .mockResolvedValueOnce({ stream: stream([
        { type: 'message.part.updated', properties: { part: { id: 'part-1', sessionID: 'other', type: 'text', text: 'ignore' }, delta: 'ignore' } },
        { type: 'message.updated', properties: { info: { id: 'user-1', sessionID: 'private-1', role: 'user' } } },
        { type: 'message.part.updated', properties: { part: { id: 'user-part', messageID: 'user-1', sessionID: 'private-1', type: 'text', text: 'never expose the prompt' }, delta: 'never expose the prompt' } },
        { type: 'message.updated', properties: { info: { id: 'assistant-1', sessionID: 'private-1', role: 'assistant' } } },
        { type: 'message.part.updated', properties: { part: { id: 'part-1', messageID: 'assistant-1', sessionID: 'private-1', type: 'text', text: 'Hello' }, delta: 'Hel' } },
        { type: 'message.part.updated', properties: { part: { id: 'part-1', messageID: 'assistant-1', sessionID: 'private-1', type: 'text', text: 'Hello' }, delta: 'lo' } },
        { type: 'session.idle', properties: { sessionID: 'private-1' } },
      ]) })
      .mockResolvedValueOnce({ stream: stream([
        { type: 'message.updated', properties: { info: { id: 'assistant-2', sessionID: 'private-1', role: 'assistant' } } },
        { type: 'message.part.updated', properties: { part: { id: 'part-2', messageID: 'assistant-2', sessionID: 'private-1', type: 'text', text: 'Again' } } },
        { type: 'session.idle', properties: { sessionID: 'private-1' } },
      ]) })
    const client = {
      session: { create, promptAsync, abort: vi.fn() },
      event: { subscribe },
      tool: { ids: vi.fn().mockResolvedValue({ data: ['custom-tool', 'bash'] }) },
    }
    const runner = new OpenCodeWalkthroughModelRunner({
      start: async () => ({ host: '127.0.0.1', port: 4099, password: 'pw' }),
      createClient: (() => client) as never,
    })
    const base = {
      cwd: '/repo',
      model: { providerID: 'openai', modelID: 'gpt-test', variant: 'high' as const },
      messages: [{ role: 'system' as const, content: 'system' }, { role: 'user' as const, content: 'first' }],
      signal: new AbortController().signal,
    }

    await expect(collect(runner.run(base))).resolves.toEqual([
      { type: 'session', sessionId: 'private-1' },
      { type: 'text-delta', delta: 'Hel' },
      { type: 'text-delta', delta: 'lo' },
      { type: 'finish' },
    ])
    await expect(collect(runner.run({ ...base, sessionId: 'private-1', messages: [{ role: 'user', content: 'second' }] }))).resolves.toEqual([
      { type: 'session', sessionId: 'private-1' },
      { type: 'text-delta', delta: 'Again' },
      { type: 'finish' },
    ])

    expect(create).toHaveBeenCalledTimes(1)
    expect(promptAsync).toHaveBeenCalledTimes(2)
    const firstBody = promptAsync.mock.calls[0]![0].body
    expect(firstBody.model).toEqual({ providerID: 'openai', modelID: 'gpt-test' })
    expect(firstBody.variant).toBe('high')
    expect(firstBody.system).toBe('system')
    expect(firstBody.tools['custom-tool']).toBe(false)
    expect(Object.values(firstBody.tools).every((enabled) => enabled === false)).toBe(true)
  })

  it('aborts the private OpenCode session through AbortSignal', async () => {
    let subscribedSignal: AbortSignal | undefined
    const abort = vi.fn().mockResolvedValue({ data: true })
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'private-abort' } }),
        promptAsync: vi.fn().mockResolvedValue({ data: undefined }),
        abort,
      },
      event: {
        subscribe: vi.fn().mockImplementation(async ({ signal }) => {
          subscribedSignal = signal
          return {
            stream: {
              async *[Symbol.asyncIterator]() {
                await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
              },
            },
          }
        }),
      },
      tool: { ids: vi.fn().mockResolvedValue({ data: [] }) },
    }
    const runner = new OpenCodeWalkthroughModelRunner({
      start: async () => ({ host: '127.0.0.1', port: 4099, password: 'pw' }),
      createClient: (() => client) as never,
    })
    const controller = new AbortController()
    const running = collect(runner.run({
      cwd: '/repo',
      model: { providerID: 'openai', modelID: 'gpt-test', variant: null },
      messages: [{ role: 'user', content: 'first' }],
      signal: controller.signal,
    }))
    await vi.waitFor(() => expect(subscribedSignal).toBe(controller.signal))
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'private-abort' } }))
  })
})
