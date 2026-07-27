export function explicitChildSessionId(part: unknown): string | null {
  if (!part || typeof part !== 'object') return null
  const record = part as Record<string, unknown>
  const candidates = [record.childSessionId, record.child_session_id]
  for (const container of [record.metadata, record.state]) {
    if (container && typeof container === 'object') {
      const value = container as Record<string, unknown>
      candidates.push(value.childSessionId, value.child_session_id, value.sessionId, value.sessionID)
    }
  }
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null
}
