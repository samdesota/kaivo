export type WorkspaceSessionLike = {
  id: string
  status: string
  workspaceId?: string | null
}

export function workspaceSessions(
  sessions: WorkspaceSessionLike[],
  workspaceId?: string,
): WorkspaceSessionLike[] {
  if (!workspaceId) return sessions
  return sessions.filter((session) => session.workspaceId === workspaceId)
}

export function selectActiveWorkspaceSession(
  sessions: WorkspaceSessionLike[],
  currentSessionId: string | null,
): string | null {
  const active = sessions.filter((session) => session.status !== 'archived')
  if (currentSessionId && active.some((session) => session.id === currentSessionId)) {
    return currentSessionId
  }
  return active[0]?.id ?? null
}
