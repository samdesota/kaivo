/**
 * Transcript store: merges OpenCode's cold-load `session.messages` response
 * with live `message.part.updated` / `message.updated` / `permission.updated`
 * events into a single ordered list the UI can render.
 *
 * Pure functions; no React. Exercised by transcript-store.test.ts.
 */

export interface MessageInfo {
  id: string
  role: 'user' | 'assistant' | string
  sessionID?: string
  time?: { created?: number; completed?: number }
  // Assistant messages carry model/usage; we pass through as opaque.
  [k: string]: unknown
}

export interface Part {
  id: string
  type: string
  messageID: string
  sessionID?: string
  [k: string]: unknown
}

export interface PermissionRequest {
  id: string
  title?: string
  pattern?: string | string[]
  metadata?: Record<string, unknown>
  // Matches a tool call via metadata.callID when present.
  callID?: string
  createdAt?: number
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionItem {
  question: string
  header?: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  questions: QuestionItem[]
  /** When set, the question came from a tool call — render attached to it. */
  callID?: string
  createdAt?: number
}

export interface TodoItem {
  id: string
  content: string
  status: string
  priority: string
}

export interface TranscriptState {
  /** Message id → info. */
  messages: Map<string, MessageInfo>
  /** Message id in the order they were first seen (roughly chronological). */
  messageOrder: string[]
  /** Part id → part (cross-message; we look up by id on updates). */
  parts: Map<string, Part>
  /** Message id → ordered list of part ids. */
  partsByMessage: Map<string, string[]>
  /** Pending permission requests, keyed by permission id. */
  permissions: Map<string, PermissionRequest>
  /** Pending question requests from the agent, keyed by request id. */
  questions: Map<string, QuestionRequest>
  /** Current todo list for the session, in opencode-emitted order. */
  todos: TodoItem[]
  /**
   * Subagent (child) opencode session IDs in creation order. Used to map the
   * Nth `task` tool call in this transcript to the Nth child session.
   */
  childOrder: string[]
  /** Child opencode session ID → its own transcript state. */
  childTranscripts: Map<string, TranscriptState>
}

export function emptyTranscript(): TranscriptState {
  return {
    messages: new Map(),
    messageOrder: [],
    parts: new Map(),
    partsByMessage: new Map(),
    permissions: new Map(),
    questions: new Map(),
    todos: [],
    childOrder: [],
    childTranscripts: new Map(),
  }
}

function upsertMessage(state: TranscriptState, info: MessageInfo): TranscriptState {
  const messages = new Map(state.messages)
  const existing = messages.get(info.id)
  // Merge — live updates can add/overwrite fields (e.g. time.completed).
  messages.set(info.id, { ...existing, ...info })
  let messageOrder = state.messageOrder
  if (!existing) {
    messageOrder = [...state.messageOrder, info.id]
    // Sort by time.created when we have it; stable for ties.
    messageOrder = [...messageOrder].sort((a, b) => {
      const ta = messages.get(a)?.time?.created ?? Number.MAX_SAFE_INTEGER
      const tb = messages.get(b)?.time?.created ?? Number.MAX_SAFE_INTEGER
      if (ta !== tb) return ta - tb
      // Fallback: preserve insertion order.
      return state.messageOrder.indexOf(a) - state.messageOrder.indexOf(b)
    })
  }
  return { ...state, messages, messageOrder }
}

function upsertPart(state: TranscriptState, part: Part): TranscriptState {
  const parts = new Map(state.parts)
  parts.set(part.id, { ...parts.get(part.id), ...part } as Part)
  const partsByMessage = new Map(state.partsByMessage)
  const existing = partsByMessage.get(part.messageID) ?? []
  if (!existing.includes(part.id)) {
    partsByMessage.set(part.messageID, [...existing, part.id])
  }
  // A part can land before its message has been announced — stub the message
  // so the UI has an ordering anchor. It will be fleshed out on the next
  // `message.updated`.
  let messages = state.messages
  let messageOrder = state.messageOrder
  if (!messages.has(part.messageID)) {
    messages = new Map(messages)
    messages.set(part.messageID, { id: part.messageID, role: 'unknown' })
    messageOrder = [...messageOrder, part.messageID]
  }
  return { ...state, parts, partsByMessage, messages, messageOrder }
}

/** Merge an entire cold-load response. Callers usually reset before hydrate. */
export function hydrateFromMessages(
  state: TranscriptState,
  msgs: Array<{ info: unknown; parts: unknown[] }>,
): TranscriptState {
  let s = state
  for (const m of msgs) {
    const info = m.info as MessageInfo
    if (info?.id) s = upsertMessage(s, info)
    for (const p of m.parts) {
      const part = p as Part
      if (part?.id && part.type && part.messageID) s = upsertPart(s, part)
    }
  }
  return s
}

/** Cold-load child sessions returned by `agent.childTranscripts`. */
export function hydrateChildren(
  state: TranscriptState,
  children: Array<{
    sessionID: string
    messages: Array<{ info: unknown; parts: unknown[] }>
  }>,
): TranscriptState {
  const childOrder = [...state.childOrder]
  const childTranscripts = new Map(state.childTranscripts)
  for (const c of children) {
    if (!childOrder.includes(c.sessionID)) childOrder.push(c.sessionID)
    const existing = childTranscripts.get(c.sessionID) ?? emptyTranscript()
    childTranscripts.set(c.sessionID, hydrateFromMessages(existing, c.messages))
  }
  return { ...state, childOrder, childTranscripts }
}

/**
 * Apply a single forwarded OpenCode event. Unknown types are ignored so new
 * SDK events don't crash the UI.
 *
 * Events with `parentSessionId` set originate from a subagent (child) session
 * and are routed into that child's sub-transcript, not the parent's.
 */
export function applyEvent(
  state: TranscriptState,
  evt: { type: string; parentSessionId?: string; payload: Record<string, unknown> },
): TranscriptState {
  // child.session.created: register a new child in arrival order so the UI
  // can pair it with the Nth task tool call in the parent.
  if (evt.type === 'child.session.created') {
    const info = (evt.payload as { info?: { id?: string } }).info
    const id = info?.id
    if (!id) return state
    if (state.childOrder.includes(id)) return state
    const childTranscripts = new Map(state.childTranscripts)
    if (!childTranscripts.has(id)) childTranscripts.set(id, emptyTranscript())
    return {
      ...state,
      childOrder: [...state.childOrder, id],
      childTranscripts,
    }
  }
  // Route child-session events into the matching sub-transcript.
  if (evt.parentSessionId) {
    // Find the child sessionID inside the payload (varies by event shape).
    const childOcId = extractEventSessionId(evt)
    if (!childOcId) return state
    const childTranscripts = new Map(state.childTranscripts)
    const prev = childTranscripts.get(childOcId) ?? emptyTranscript()
    const next = applyEvent(prev, { ...evt, parentSessionId: undefined })
    childTranscripts.set(childOcId, next)
    const childOrder = state.childOrder.includes(childOcId)
      ? state.childOrder
      : [...state.childOrder, childOcId]
    return { ...state, childTranscripts, childOrder }
  }
  switch (evt.type) {
    case 'message.updated': {
      const info = (evt.payload as { info?: MessageInfo }).info
      if (info?.id) return upsertMessage(state, info)
      return state
    }
    case 'message.part.updated': {
      const part = (evt.payload as { part?: Part }).part
      if (part?.id && part.type && part.messageID) return upsertPart(state, part)
      return state
    }
    case 'permission.updated': {
      const p = evt.payload as {
        id?: string
        callID?: string
        title?: string
        pattern?: string | string[]
        metadata?: Record<string, unknown>
        time?: { created?: number }
      }
      if (!p.id) return state
      const permissions = new Map(state.permissions)
      permissions.set(p.id, {
        id: p.id,
        title: p.title,
        pattern: p.pattern,
        metadata: p.metadata,
        // Permission.callID is top-level on the payload; falling back to
        // metadata.callID covers older OpenCode versions that nested it.
        callID: p.callID ?? (p.metadata as { callID?: string } | undefined)?.callID,
        createdAt: p.time?.created,
      })
      return { ...state, permissions }
    }
    case 'permission.replied': {
      const p = evt.payload as { permissionID?: string }
      if (!p.permissionID) return state
      const permissions = new Map(state.permissions)
      permissions.delete(p.permissionID)
      return { ...state, permissions }
    }
    case 'question.asked': {
      const q = evt.payload as {
        id?: string
        questions?: QuestionItem[]
        tool?: { callID?: string }
      }
      if (!q.id) return state
      const questions = new Map(state.questions)
      questions.set(q.id, {
        id: q.id,
        questions: Array.isArray(q.questions) ? q.questions : [],
        callID: q.tool?.callID,
        createdAt: Date.now(),
      })
      return { ...state, questions }
    }
    case 'question.replied':
    case 'question.rejected': {
      const q = evt.payload as { requestID?: string }
      if (!q.requestID) return state
      const questions = new Map(state.questions)
      questions.delete(q.requestID)
      return { ...state, questions }
    }
    case 'todo.updated': {
      const t = evt.payload as { todos?: TodoItem[] }
      if (!Array.isArray(t.todos)) return state
      return { ...state, todos: t.todos }
    }
    default:
      return state
  }
}

/** Flat, ordered list of parts for rendering. */
export function flattenParts(state: TranscriptState): Part[] {
  const out: Part[] = []
  for (const mid of state.messageOrder) {
    const ids = state.partsByMessage.get(mid) ?? []
    for (const pid of ids) {
      const p = state.parts.get(pid)
      if (p) out.push(p)
    }
  }
  return out
}

function extractEventSessionId(evt: {
  type: string
  payload: Record<string, unknown>
}): string | undefined {
  switch (evt.type) {
    case 'message.updated':
      return (evt.payload as { info?: { sessionID?: string } }).info?.sessionID
    case 'message.part.updated':
      return (evt.payload as { part?: { sessionID?: string } }).part?.sessionID
    case 'permission.updated':
    case 'permission.replied':
    case 'session.idle':
    case 'session.error':
    case 'question.asked':
    case 'question.replied':
    case 'question.rejected':
    case 'todo.updated':
      return (evt.payload as { sessionID?: string }).sessionID
    default:
      return undefined
  }
}

/** Lookup: find a permission whose callID matches a tool part. */
export function permissionForCall(
  state: TranscriptState,
  callID: string,
): PermissionRequest | undefined {
  for (const req of state.permissions.values()) {
    if (req.callID === callID) return req
  }
  return undefined
}

/** Lookup: find a pending question that was raised by a specific tool call. */
export function questionForCall(
  state: TranscriptState,
  callID: string,
): QuestionRequest | undefined {
  for (const q of state.questions.values()) {
    if (q.callID === callID) return q
  }
  return undefined
}
