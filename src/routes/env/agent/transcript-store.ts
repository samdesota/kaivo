/**
 * Transcript store: merges OpenCode's cold-load `session.messages` response
 * with live `message.part.updated` / `message.updated` / `permission.updated`
 * events into a single ordered list the UI can render.
 *
 * Pure functions; no React.
 */

export interface MessageInfo {
  id: string
  role: 'user' | 'assistant' | string
  sessionID?: string
  time?: { created?: number; completed?: number }
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
  messages: Map<string, MessageInfo>
  messageOrder: string[]
  parts: Map<string, Part>
  partsByMessage: Map<string, string[]>
  permissions: Map<string, PermissionRequest>
  questions: Map<string, QuestionRequest>
  todos: TodoItem[]
  childOrder: string[]
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
  messages.set(info.id, { ...existing, ...info })
  let messageOrder = state.messageOrder
  if (!existing) {
    messageOrder = [...state.messageOrder, info.id]
    messageOrder = [...messageOrder].sort((a, b) => {
      const ta = messages.get(a)?.time?.created ?? Number.MAX_SAFE_INTEGER
      const tb = messages.get(b)?.time?.created ?? Number.MAX_SAFE_INTEGER
      if (ta !== tb) return ta - tb
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
  let messages = state.messages
  let messageOrder = state.messageOrder
  if (!messages.has(part.messageID)) {
    messages = new Map(messages)
    messages.set(part.messageID, { id: part.messageID, role: 'unknown' })
    messageOrder = [...messageOrder, part.messageID]
  }
  return { ...state, parts, partsByMessage, messages, messageOrder }
}

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

export function applyEvent(
  state: TranscriptState,
  evt: { type: string; parentSessionId?: string; payload: Record<string, unknown> },
): TranscriptState {
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
  if (evt.parentSessionId) {
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

export function permissionForCall(
  state: TranscriptState,
  callID: string,
): PermissionRequest | undefined {
  for (const req of state.permissions.values()) {
    if (req.callID === callID) return req
  }
  return undefined
}

export function questionForCall(
  state: TranscriptState,
  callID: string,
): QuestionRequest | undefined {
  for (const q of state.questions.values()) {
    if (q.callID === callID) return q
  }
  return undefined
}
