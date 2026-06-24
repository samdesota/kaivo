import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChatStateStore,
  type ChatSessionStatus,
  type ChatStateApi,
  type ChatTranscriptEvent,
} from '../../src/routes/env/agent/chat-state'

function status(overrides: Partial<ChatSessionStatus> = {}): ChatSessionStatus {
  return {
    running: false,
    pendingApprovals: [],
    pendingQuestions: [],
    todos: [],
    contextUsage: null,
    ...overrides,
  }
}

class MockChatApi implements ChatStateApi {
  messages: Array<{ info: unknown; parts: unknown[] }> = []
  children: Array<{ sessionID: string; messages: Array<{ info: unknown; parts: unknown[] }> }> = []
  replay: ChatTranscriptEvent[] = []
  latestSeq = 0
  currentStatus = status()
  subscriptions: Array<{
    sessionId: string
    sinceSeq: number
    handlers: { onData: (evt: ChatTranscriptEvent) => void; onError: (err: unknown) => void }
    unsubscribed: boolean
  }> = []

  sessionMessages = vi.fn(async () => this.messages)
  childTranscripts = vi.fn(async () => this.children)
  transcriptReplay = vi.fn(async (_sessionId: string, sinceSeq: number) => this.replay.filter((evt) => (evt.seq ?? 0) > sinceSeq))
  transcriptLatestSeq = vi.fn(async () => this.latestSeq)
  sessionStatus = vi.fn(async () => this.currentStatus)

  subscribeTranscript(
    sessionId: string,
    sinceSeq: number,
    handlers: { onData: (evt: ChatTranscriptEvent) => void; onError: (err: unknown) => void },
  ): () => void {
    const sub = { sessionId, sinceSeq, handlers, unsubscribed: false }
    this.subscriptions.push(sub)
    return () => {
      sub.unsubscribed = true
    }
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('ChatStateStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hydrates once and subscribes from the latest replay sequence', async () => {
    const api = new MockChatApi()
    api.latestSeq = 7
    api.messages = [
      {
        info: { id: 'm1', role: 'assistant', time: { created: 1 } },
        parts: [{ id: 'p1', type: 'text', messageID: 'm1', text: 'hello' }],
      },
    ]
    const store = new ChatStateStore(api)

    const release = store.retainSession('s1')
    await flush()

    expect(api.sessionMessages).toHaveBeenCalledTimes(1)
    expect(api.childTranscripts).toHaveBeenCalledTimes(1)
    expect(api.transcriptLatestSeq).toHaveBeenCalledTimes(1)
    expect(api.subscriptions).toHaveLength(1)
    expect(api.subscriptions[0]?.sinceSeq).toBe(7)
    expect(store.getSnapshot('s1').state.parts.get('p1')?.text).toBe('hello')

    release()
  })

  it('applies live events, dedupes by seq, and tracks running state', async () => {
    const api = new MockChatApi()
    const store = new ChatStateStore(api)
    store.retainSession('s1')
    await flush()

    const evt: ChatTranscriptEvent = {
      seq: 1,
      type: 'message.part.updated',
      payload: { part: { id: 'p1', type: 'text', messageID: 'm1', text: 'streaming', sessionID: 'oc1' } },
    }
    api.subscriptions[0]?.handlers.onData(evt)
    api.subscriptions[0]?.handlers.onData(evt)

    const snap = store.getSnapshot('s1')
    expect(snap.running).toBe(true)
    expect(snap.state.parts.get('p1')?.text).toBe('streaming')

    api.subscriptions[0]?.handlers.onData({
      seq: 2,
      type: 'session.idle',
      payload: { sessionID: 'oc1' },
    })
    expect(store.getSnapshot('s1').running).toBe(false)
  })

  it('sets running from an explicit backend session.busy event', async () => {
    const api = new MockChatApi()
    const store = new ChatStateStore(api)
    store.retainSession('s1')
    await flush()

    api.subscriptions[0]?.handlers.onData({
      seq: 1,
      type: 'session.busy',
      payload: { sessionID: 'oc1' },
    })

    expect(store.getSnapshot('s1').running).toBe(true)
  })

  it('renders session errors as transcript parts and stops running', async () => {
    const api = new MockChatApi()
    const store = new ChatStateStore(api)
    store.retainSession('s1')
    await flush()

    api.subscriptions[0]?.handlers.onData({
      seq: 1,
      type: 'session.busy',
      payload: { sessionID: 'oc1' },
    })
    api.subscriptions[0]?.handlers.onData({
      seq: 2,
      type: 'session.error',
      payload: {
        sessionID: 'oc1',
        message: 'AI_APICallError: Insufficient balance or no resource package. Please recharge.',
        time: { created: 123 },
      },
    })

    const snap = store.getSnapshot('s1')
    expect(snap.running).toBe(false)
    const part = [...snap.state.parts.values()].find((candidate) => candidate.type === 'session-error')
    expect(part?.message).toContain('Insufficient balance')
  })

  it('hydrates persisted session errors from transcript replay', async () => {
    const api = new MockChatApi()
    api.latestSeq = 2
    api.replay = [
      {
        seq: 1,
        type: 'session.busy',
        payload: { sessionID: 'oc1' },
      },
      {
        seq: 2,
        type: 'session.error',
        payload: {
          sessionID: 'oc1',
          message: 'unknown provider for model gpt-5.5-pro',
          time: { created: 123 },
        },
      },
    ]
    const store = new ChatStateStore(api)

    store.retainSession('s1')
    await flush()

    expect(api.transcriptReplay).toHaveBeenCalledWith('s1', 0)
    expect(api.subscriptions[0]?.sinceSeq).toBe(2)
    const snap = store.getSnapshot('s1')
    expect(snap.running).toBe(false)
    const part = [...snap.state.parts.values()].find((candidate) => candidate.type === 'session-error')
    expect(part?.message).toBe('unknown provider for model gpt-5.5-pro')
  })

  it('keeps the optimistic user message visible and hides the real echo until idle', async () => {
    const api = new MockChatApi()
    const store = new ChatStateStore(api)
    store.retainSession('s1')
    await flush()

    const optimisticId = store.addOptimisticUserMessage('s1', 'hello agent')
    let snap = store.getSnapshot('s1')
    expect(snap.running).toBe(true)
    expect(snap.state.messages.get(optimisticId)?.role).toBe('user')
    expect(snap.state.parts.get(`${optimisticId}:text`)?.text).toBe('hello agent')

    api.subscriptions[0]?.handlers.onData({
      seq: 1,
      type: 'message.updated',
      payload: { info: { id: 'real-user-message', role: 'user', time: { created: 1 } } },
    })
    api.subscriptions[0]?.handlers.onData({
      seq: 2,
      type: 'message.part.updated',
      payload: {
        part: {
          id: 'real-user-part',
          type: 'text',
          messageID: 'real-user-message',
          text: 'hello agent',
          sessionID: 'oc1',
        },
      },
    })

    snap = store.getSnapshot('s1')
    expect(snap.state.messages.has(optimisticId)).toBe(false)
    expect(snap.state.parts.has(`${optimisticId}:text`)).toBe(false)
    expect(snap.state.parts.get('real-user-part')?.text).toBe('hello agent')

    api.subscriptions[0]?.handlers.onData({
      seq: 3,
      type: 'session.idle',
      payload: { sessionID: 'oc1' },
    })

    snap = store.getSnapshot('s1')
    expect(snap.state.messages.has(optimisticId)).toBe(false)
    expect(snap.state.parts.has(`${optimisticId}:text`)).toBe(false)
  })

  it('removes an optimistic user message when send fails', async () => {
    const api = new MockChatApi()
    const store = new ChatStateStore(api)
    store.retainSession('s1')
    await flush()

    const optimisticId = store.addOptimisticUserMessage('s1', 'will fail')
    expect(store.getSnapshot('s1').state.messages.has(optimisticId)).toBe(true)

    store.removeOptimisticUserMessage('s1', optimisticId)
    expect(store.getSnapshot('s1').state.messages.has(optimisticId)).toBe(false)
    expect(store.getSnapshot('s1').state.parts.has(`${optimisticId}:text`)).toBe(false)
  })

  it('replays missed data and reconnects with exponential retry after subscription errors', async () => {
    const api = new MockChatApi()
    const store = new ChatStateStore(api)
    store.retainSession('s1')
    await flush()

    api.latestSeq = 3
    api.messages = [
      {
        info: { id: 'm1', role: 'assistant', time: { created: 1 } },
        parts: [{ id: 'p1', type: 'text', messageID: 'm1', text: 'replayed' }],
      },
    ]
    api.subscriptions[0]?.handlers.onError(new Error('ws down'))

    expect(store.getSnapshot('s1').reconnecting).toBe(true)
    expect(api.subscriptions[0]?.unsubscribed).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    await flush()

    expect(api.subscriptions).toHaveLength(2)
    expect(api.subscriptions[1]?.sinceSeq).toBe(3)
    expect(store.getSnapshot('s1').reconnecting).toBe(false)
    expect(store.getSnapshot('s1').state.parts.get('p1')?.text).toBe('replayed')
  })

  it('keeps chat readers alive after view subscribers release them', async () => {
    const api = new MockChatApi()
    const store = new ChatStateStore(api)
    const releaseA = store.retainSession('s1')
    const releaseB = store.retainSession('s1')
    await flush()

    expect(api.subscriptions).toHaveLength(1)
    releaseA()
    expect(api.subscriptions[0]?.unsubscribed).toBe(false)

    releaseB()
    expect(api.subscriptions[0]?.unsubscribed).toBe(false)

    api.subscriptions[0]?.handlers.onData({
      seq: 1,
      type: 'message.part.updated',
      payload: { part: { id: 'p1', type: 'text', messageID: 'm1', text: 'still reading', sessionID: 'oc1' } },
    })

    expect(store.getSnapshot('s1').state.parts.get('p1')?.text).toBe('still reading')

    store.dispose()
    expect(api.subscriptions[0]?.unsubscribed).toBe(true)
  })

  it('reconciles status into pending approvals, questions, and todos', async () => {
    const api = new MockChatApi()
    api.currentStatus = status({
      pendingApprovals: [
        {
          id: 'perm1',
          sessionId: 'oc1',
          title: 'Approval required',
          metadata: {},
          createdAt: 1,
        },
      ],
      pendingQuestions: [{ id: 'q1', sessionId: 'oc1', questions: [], tool: { callID: 'call1' } }],
      todos: [{ id: 't1', content: 'Do thing', status: 'pending', priority: 'high' }],
    })
    const store = new ChatStateStore(api)
    store.retainSession('s1')
    await flush()

    const snap = store.getSnapshot('s1')
    expect(snap.state.permissions.has('perm1')).toBe(true)
    expect(snap.state.questions.has('q1')).toBe(true)
    expect(snap.state.todos).toEqual(api.currentStatus.todos)
  })
})
