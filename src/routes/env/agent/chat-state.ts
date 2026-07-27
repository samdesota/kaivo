import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { makeEnvClient, type EnvRef } from '../../../lib/env-client'
import { useEnv } from '../env-context'
import {
  applyEvent,
  emptyTranscript,
  hydrateTranscriptProjection,
  type ChildTranscript,
  type OpenCodeMessage,
  type OverlayTranscriptEvent,
  type TranscriptState,
} from './transcript-store'
import { chatDebug } from './chat-debug'
import { recordAgentRunFinished, recordAgentRunStarted } from '../../../lib/agent-notification-sounds'

export interface ChatTranscriptEvent extends OverlayTranscriptEvent {
  seq?: number
  type: string
  parentSessionId?: string
  payload: Record<string, unknown>
}

export interface ChatSessionStatus {
  running: boolean
  pendingApprovals: Array<{
    id: string
    sessionId: string
    callID?: string
    title: string
    pattern?: string | string[]
    metadata: Record<string, unknown>
    createdAt: number
  }>
  pendingQuestions: Array<{
    id: string
    sessionId: string
    questions: unknown[]
    tool?: unknown
  }>
  todos: Array<{ id: string; content: string; status: string; priority: string }>
  contextUsage: { used: number; limit: number } | null
  queuedMessages?: Array<{ id: string; text: string; createdAt: number }>
}

export interface ChatSnapshot {
  state: TranscriptState
  loading: boolean
  error: unknown | null
  reconnecting: boolean
  running: boolean
  status: ChatSessionStatus | null
}

export interface ChatStateApi {
  openCodeMessages(sessionId: string): Promise<OpenCodeMessage[]>
  childTranscripts(sessionId: string): Promise<ChildTranscript[]>
  overlayEvents(sessionId: string, sinceSeq: number): Promise<OverlayTranscriptEvent[]>
  transcriptLatestSeq(sessionId: string): Promise<number>
  sessionStatus(sessionId: string): Promise<ChatSessionStatus>
  subscribeTranscript(
    sessionId: string,
    sinceSeq: number,
    handlers: { onData: (evt: ChatTranscriptEvent) => void; onError: (err: unknown) => void },
  ): () => void
}

interface TrpcChatClient {
  agent: {
    openCodeSessionMessages: { query(input: { sessionId: string }): Promise<OpenCodeMessage[]> }
    childTranscripts: {
      query(input: { sessionId: string }): Promise<ChildTranscript[]>
    }
    transcriptReplay: { query(input: { sessionId: string; sinceSeq: number }): Promise<OverlayTranscriptEvent[]> }
    transcriptLatestSeq: { query(input: { sessionId: string }): Promise<{ seq?: number }> }
    sessionStatus: { query(input: { sessionId: string }): Promise<ChatSessionStatus> }
    transcript: {
      subscribe(
        input: { sessionId: string; sinceSeq: number },
        handlers: {
          onData: (evt: ChatTranscriptEvent) => void
          onError: (err: unknown) => void
        },
      ): { unsubscribe(): void }
    }
  }
}

interface SessionEntry extends ChatSnapshot {
  snapshot: ChatSnapshot
  lastSeenSeq: number
  seenSeqs: Set<number>
  retainCount: number
  hydrating: boolean
  unsubscribe: (() => void) | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  statusTimer: ReturnType<typeof setTimeout> | null
  optimisticMessages: Map<string, string>
}

const EMPTY_SNAPSHOT: ChatSnapshot = {
  state: emptyTranscript(),
  loading: false,
  error: null,
  reconnecting: false,
  running: false,
  status: null,
}

const STATUS_POLL_MS = 3_000

export class ChatStateStore {
  private sessions = new Map<string, SessionEntry>()
  private listeners = new Map<string, Set<() => void>>()
  private optimisticCounter = 0

  constructor(private api: ChatStateApi) {}

  getSnapshot(sessionId: string): ChatSnapshot {
    return this.sessions.get(sessionId)?.snapshot ?? EMPTY_SNAPSHOT
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      const existing = this.listeners.get(sessionId)
      existing?.delete(listener)
      if (existing?.size === 0) this.listeners.delete(sessionId)
    }
  }

  retainSession(sessionId: string): () => void {
    const entry = this.ensureEntry(sessionId)
    entry.retainCount++
    this.start(sessionId, entry)
    this.emit(sessionId)
    return () => this.releaseSession(sessionId)
  }

  markSent(sessionId: string): void {
    const entry = this.ensureEntry(sessionId)
    entry.running = true
    this.emit(sessionId)
  }

  addOptimisticUserMessage(sessionId: string, text: string): string {
    const entry = this.ensureEntry(sessionId)
    const id = `optimistic:${++this.optimisticCounter}`
    chatDebug('store:optimistic:add:before', {
      sessionId,
      id,
      loading: entry.loading,
      running: entry.running,
      messageCount: entry.state.messageOrder.length,
      partCount: entry.state.parts.size,
    })
    entry.optimisticMessages.set(id, text)
    entry.running = true
    entry.state = addOptimisticMessage(entry.state, id, text)
    chatDebug('store:optimistic:add:after', {
      sessionId,
      id,
      loading: entry.loading,
      running: entry.running,
      messageCount: entry.state.messageOrder.length,
      partCount: entry.state.parts.size,
      hasMessage: entry.state.messages.has(id),
      hasPart: entry.state.parts.has(`${id}:text`),
    })
    this.emit(sessionId)
    return id
  }

  removeOptimisticUserMessage(sessionId: string, optimisticId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || !entry.optimisticMessages.has(optimisticId)) return
    chatDebug('store:optimistic:remove', { sessionId, optimisticId })
    entry.optimisticMessages.delete(optimisticId)
    entry.state = removeMessage(entry.state, optimisticId)
    entry.running = entry.status?.running ?? false
    this.emit(sessionId)
  }

  dispose(): void {
    for (const sessionId of this.sessions.keys()) this.stop(sessionId)
    this.sessions.clear()
    this.listeners.clear()
  }

  private ensureEntry(sessionId: string): SessionEntry {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const entry: SessionEntry = {
      state: emptyTranscript(),
      loading: true,
      error: null,
      reconnecting: false,
      running: false,
      status: null,
      snapshot: EMPTY_SNAPSHOT,
      lastSeenSeq: 0,
      seenSeqs: new Set(),
      retainCount: 0,
      hydrating: false,
      unsubscribe: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      statusTimer: null,
      optimisticMessages: new Map(),
    }
    entry.snapshot = this.createSnapshot(entry)
    this.sessions.set(sessionId, entry)
    return entry
  }

  private releaseSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.retainCount = Math.max(0, entry.retainCount - 1)
    if (entry.retainCount === 0) this.stop(sessionId)
    this.emit(sessionId)
  }

  private start(sessionId: string, entry: SessionEntry): void {
    if (!entry.hydrating && !entry.unsubscribe) void this.hydrateAndSubscribe(sessionId, entry)
    if (!entry.statusTimer) void this.pollStatus(sessionId, entry)
  }

  private stop(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.unsubscribe?.()
    entry.unsubscribe = null
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = null
    if (entry.statusTimer) clearTimeout(entry.statusTimer)
    entry.statusTimer = null
  }

  private async hydrateAndSubscribe(sessionId: string, entry: SessionEntry): Promise<void> {
    entry.hydrating = true
    entry.loading = true
    entry.error = null
    this.emit(sessionId)
    try {
      const [messages, children, overlays, latestSeq, status] = await Promise.all([
        this.api.openCodeMessages(sessionId),
        this.api.childTranscripts(sessionId),
        this.api.overlayEvents(sessionId, 0),
        this.api.transcriptLatestSeq(sessionId),
        this.api.sessionStatus(sessionId).catch(() => null),
      ])
      if (!this.isRetained(sessionId, entry)) return
      chatDebug('store:hydrate:resolved', {
        sessionId,
        messages: messages.length,
        children: children.length,
        overlays: overlays.length,
        latestSeq,
        hadStatus: Boolean(status),
        optimisticCount: entry.optimisticMessages.size,
      })
      entry.state = hydrateTranscriptProjection({ messages, children, overlays })
      entry.state = reapplyOptimisticMessages(entry.state, entry.optimisticMessages)
      entry.lastSeenSeq = latestSeq
      entry.seenSeqs = new Set()
      if (status) this.applyStatus(entry, status)
      entry.loading = false
      entry.reconnecting = false
      entry.reconnectAttempt = 0
      entry.hydrating = false
      this.emit(sessionId)
      this.openSubscription(sessionId, entry)
    } catch (err) {
      if (!this.isRetained(sessionId, entry)) return
      entry.hydrating = false
      entry.loading = false
      entry.error = err
      entry.reconnecting = true
      this.emit(sessionId)
      this.scheduleReconnect(sessionId, entry)
    }
  }

  private openSubscription(sessionId: string, entry: SessionEntry): void {
    if (!this.isRetained(sessionId, entry)) return
    entry.unsubscribe?.()
    entry.unsubscribe = this.api.subscribeTranscript(sessionId, entry.lastSeenSeq, {
      onData: (evt) => this.handleEvent(sessionId, evt),
      onError: (err) => this.handleSubscriptionError(sessionId, err),
    })
  }

  private handleEvent(sessionId: string, evt: ChatTranscriptEvent): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || !this.isRetained(sessionId, entry)) return
    entry.reconnecting = false
    entry.reconnectAttempt = 0
    entry.error = null
    if (typeof evt.seq === 'number') {
      entry.lastSeenSeq = Math.max(entry.lastSeenSeq, evt.seq)
      if (entry.seenSeqs.has(evt.seq)) return
      entry.seenSeqs.add(evt.seq)
    }
    chatDebug('store:event', {
      sessionId,
      seq: evt.seq,
      type: evt.type,
      parentSessionId: evt.parentSessionId,
      runningBefore: entry.running,
      optimisticCount: entry.optimisticMessages.size,
    })
    if (evt.type === 'session.busy') {
      if ((evt.payload as { sessionID?: string })?.sessionID && !evt.parentSessionId) {
        if (!entry.running) recordAgentRunStarted(sessionId)
        entry.running = true
      }
    } else if (evt.type === 'session.idle' || evt.type === 'session.error') {
      if ((evt.payload as { sessionID?: string })?.sessionID && !evt.parentSessionId) {
        if (entry.running) recordAgentRunFinished(sessionId)
        entry.running = false
        entry.optimisticMessages.clear()
        entry.state = removeAllOptimisticMessages(entry.state)
      }
    } else if (evt.type === 'message.part.updated' && !evt.parentSessionId) {
      entry.running = true
    }
    entry.state = applyEvent(entry.state, evt)
    entry.state = removeEchoedOptimisticMessages(entry.state, entry.optimisticMessages)
    chatDebug('store:event:after', {
      sessionId,
      type: evt.type,
      running: entry.running,
      messageCount: entry.state.messageOrder.length,
      partCount: entry.state.parts.size,
      optimisticCount: entry.optimisticMessages.size,
    })
    this.emit(sessionId)
  }

  private handleSubscriptionError(sessionId: string, err: unknown): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.unsubscribe?.()
    entry.unsubscribe = null
    entry.error = err
    entry.reconnecting = true
    this.emit(sessionId)
    this.scheduleReconnect(sessionId, entry)
  }

  private scheduleReconnect(sessionId: string, entry: SessionEntry): void {
    if (!this.isRetained(sessionId, entry) || entry.reconnectTimer) return
    const attempt = entry.reconnectAttempt++
    const delay = Math.min(1_000 * 2 ** attempt, 10_000)
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null
      if (!this.isRetained(sessionId, entry)) return
      void this.replayAndReconnect(sessionId, entry)
    }, delay)
  }

  private async replayAndReconnect(sessionId: string, entry: SessionEntry): Promise<void> {
    try {
      const replayFromSeq = entry.lastSeenSeq
      const [messages, children, overlays, latestSeq] = await Promise.all([
        this.api.openCodeMessages(sessionId),
        this.api.childTranscripts(sessionId),
        this.api.overlayEvents(sessionId, replayFromSeq),
        this.api.transcriptLatestSeq(sessionId),
      ])
      if (!this.isRetained(sessionId, entry)) return
      entry.state = hydrateTranscriptProjection({ state: entry.state, messages, children, overlays })
      entry.state = removeEchoedOptimisticMessages(entry.state, entry.optimisticMessages)
      entry.lastSeenSeq = Math.max(entry.lastSeenSeq, latestSeq, ...overlays.map((evt) => evt.seq ?? 0))
      entry.reconnecting = false
      entry.error = null
      this.emit(sessionId)
      this.openSubscription(sessionId, entry)
    } catch (err) {
      if (!this.isRetained(sessionId, entry)) return
      entry.error = err
      entry.reconnecting = true
      this.emit(sessionId)
      this.scheduleReconnect(sessionId, entry)
    }
  }

  private async pollStatus(sessionId: string, entry: SessionEntry): Promise<void> {
    try {
      const status = await this.api.sessionStatus(sessionId)
      if (!this.isRetained(sessionId, entry)) return
      this.applyStatus(entry, status)
      this.emit(sessionId)
    } catch (err) {
      if (!this.isRetained(sessionId, entry)) return
      entry.error = err
      this.emit(sessionId)
    } finally {
      if (!this.isRetained(sessionId, entry)) return
      entry.statusTimer = setTimeout(() => void this.pollStatus(sessionId, entry), STATUS_POLL_MS)
    }
  }

  private applyStatus(entry: SessionEntry, status: ChatSessionStatus): void {
    chatDebug('store:status', {
      runningFromStatus: status.running,
      optimisticCount: entry.optimisticMessages.size,
      runningBefore: entry.running,
    })
    entry.status = status
    entry.running = status.running || entry.optimisticMessages.size > 0
    entry.state = reconcileStatus(entry.state, status)
  }

  private isRetained(sessionId: string, entry: SessionEntry): boolean {
    return this.sessions.get(sessionId) === entry && entry.retainCount > 0
  }

  private emit(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry) entry.snapshot = this.createSnapshot(entry)
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }

  private createSnapshot(entry: SessionEntry): ChatSnapshot {
    return {
      state: entry.state,
      loading: entry.loading,
      error: entry.error,
      reconnecting: entry.reconnecting,
      running: entry.running,
      status: entry.status,
    }
  }
}

function addOptimisticMessage(state: TranscriptState, id: string, text: string): TranscriptState {
  const now = Date.now()
  let next = applyEvent(state, {
    type: 'message.updated',
    payload: {
      info: {
        id,
        role: 'user',
        time: { created: now, completed: now },
        optimistic: true,
      },
    },
  })
  next = applyEvent(next, {
    type: 'message.part.updated',
    payload: {
      part: {
        id: `${id}:text`,
        type: 'text',
        messageID: id,
        text,
        optimistic: true,
        time: { start: now, end: now },
      },
    },
  })
  return next
}

function reapplyOptimisticMessages(state: TranscriptState, optimisticMessages: Map<string, string>): TranscriptState {
  let next = removeEchoedOptimisticMessages(state, optimisticMessages)
  for (const [id, text] of optimisticMessages) {
    if (!next.messages.has(id)) next = addOptimisticMessage(next, id, text)
  }
  return next
}

function removeEchoedOptimisticMessages(state: TranscriptState, optimisticMessages: Map<string, string>): TranscriptState {
  let next = state
  for (const [id, text] of optimisticMessages) {
    if (!hasRealUserText(next, text)) continue
    optimisticMessages.delete(id)
    next = removeMessage(next, id)
  }
  return next
}

function hasRealUserText(state: TranscriptState, text: string): boolean {
  for (const part of state.parts.values()) {
    if ((part as { optimistic?: boolean }).optimistic) continue
    if (part.type !== 'text') continue
    if ((part as { text?: string }).text !== text) continue
    if (state.messages.get(part.messageID)?.role === 'user') return true
  }
  return false
}

function removeAllOptimisticMessages(state: TranscriptState): TranscriptState {
  let next = state
  for (const message of state.messages.values()) {
    if ((message as { optimistic?: boolean }).optimistic) next = removeMessage(next, message.id)
  }
  return next
}

function removeMessage(state: TranscriptState, messageId: string): TranscriptState {
  const messages = new Map(state.messages)
  const parts = new Map(state.parts)
  const partsByMessage = new Map(state.partsByMessage)
  const messageOrder = state.messageOrder.filter((id) => id !== messageId)
  const partIds = partsByMessage.get(messageId) ?? []
  for (const partId of partIds) parts.delete(partId)
  messages.delete(messageId)
  partsByMessage.delete(messageId)
  return { ...state, messages, parts, partsByMessage, messageOrder }
}

export function reconcileStatus(state: TranscriptState, status: ChatSessionStatus): TranscriptState {
  let next = state
  for (const p of status.pendingApprovals) {
    if (!next.permissions.has(p.id)) {
      next = applyEvent(next, {
        type: 'permission.updated',
        payload: {
          id: p.id,
          sessionID: p.sessionId,
          callID: p.callID,
          title: p.title,
          pattern: p.pattern,
          metadata: p.metadata,
          time: { created: p.createdAt },
        },
      })
    }
  }
  for (const id of next.permissions.keys()) {
    if (!status.pendingApprovals.some((p) => p.id === id)) {
      next = applyEvent(next, { type: 'permission.replied', payload: { permissionID: id } })
    }
  }
  for (const q of status.pendingQuestions) {
    if (!next.questions.has(q.id)) {
      next = applyEvent(next, {
        type: 'question.asked',
        payload: {
          id: q.id,
          sessionID: q.sessionId,
          questions: q.questions,
          tool: q.tool,
        },
      })
    }
  }
  for (const id of next.questions.keys()) {
    if (!status.pendingQuestions.some((q) => q.id === id)) {
      next = applyEvent(next, { type: 'question.replied', payload: { requestID: id } })
    }
  }
  if (status.todos.length > 0 || next.todos.length > 0) {
    next = applyEvent(next, { type: 'todo.updated', payload: { todos: status.todos } })
  }
  return next
}

const stores = new Map<string, ChatStateStore>()

export function getChatStateStore(env: EnvRef, envToken: string): ChatStateStore {
  const key = `${env.id}:${env.url}:${envToken}`
  let store = stores.get(key)
  if (!store) {
    store = new ChatStateStore(createTrpcChatStateApi(env, envToken))
    stores.set(key, store)
  }
  return store
}

export function createTrpcChatStateApi(env: EnvRef, envToken: string): ChatStateApi {
  const client = makeEnvClient(env, envToken) as unknown as TrpcChatClient
  return {
    openCodeMessages(sessionId) {
      return client.agent.openCodeSessionMessages.query({ sessionId })
    },
    childTranscripts(sessionId) {
      return client.agent.childTranscripts.query({ sessionId })
    },
    overlayEvents(sessionId, sinceSeq) {
      return client.agent.transcriptReplay.query({ sessionId, sinceSeq })
    },
    async transcriptLatestSeq(sessionId) {
      const res = await client.agent.transcriptLatestSeq.query({ sessionId })
      return typeof res?.seq === 'number' ? res.seq : 0
    },
    sessionStatus(sessionId) {
      return client.agent.sessionStatus.query({ sessionId })
    },
    subscribeTranscript(sessionId, sinceSeq, handlers) {
      const sub = client.agent.transcript.subscribe(
        { sessionId, sinceSeq },
        {
          onData: handlers.onData,
          onError: handlers.onError,
        },
      )
      return () => sub.unsubscribe()
    },
  }
}

export function useChatStateStore(): ChatStateStore {
  const { env, envToken } = useEnv()
  return useMemo(() => getChatStateStore(env, envToken), [env, envToken])
}

export function useRetainChatSessions(sessionIds: string[]): void {
  const store = useChatStateStore()
  const key = sessionIds.join('\0')
  useEffect(() => {
    const releases = sessionIds.map((id) => store.retainSession(id))
    return () => {
      for (const release of releases) release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key])
}

export function useChatSession(sessionId: string): ChatSnapshot {
  const store = useChatStateStore()
  return useSyncExternalStore(
    (listener) => store.subscribe(sessionId, listener),
    () => store.getSnapshot(sessionId),
    () => EMPTY_SNAPSHOT,
  )
}
