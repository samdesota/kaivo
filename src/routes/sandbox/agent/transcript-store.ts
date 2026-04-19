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
}

export function emptyTranscript(): TranscriptState {
  return {
    messages: new Map(),
    messageOrder: [],
    parts: new Map(),
    partsByMessage: new Map(),
    permissions: new Map(),
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

/**
 * Apply a single forwarded OpenCode event. Unknown types are ignored so new
 * SDK events don't crash the UI.
 */
export function applyEvent(
  state: TranscriptState,
  evt: { type: string; payload: Record<string, unknown> },
): TranscriptState {
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
