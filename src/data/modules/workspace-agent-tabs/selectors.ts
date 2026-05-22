import { useMemo } from 'react'
import { sortWorkspaceAgentTabRows, workspaceAgentTabsCollection } from './collection'
import type { AgentSessionSummary, WorkspaceAgentTabRecord } from './types'

export function useWorkspaceAgentTabRecords(workspaceId: string | undefined): WorkspaceAgentTabRecord[] {
  const rows = workspaceAgentTabsCollection.useRows()
  return useMemo(() => {
    if (!workspaceId) return []
    return sortWorkspaceAgentTabRows(rows.filter((row) => row.workspaceId === workspaceId))
  }, [rows, workspaceId])
}

export function getWorkspaceAgentTabRecords(workspaceId: string): WorkspaceAgentTabRecord[] {
  return sortWorkspaceAgentTabRows(workspaceAgentTabsCollection.getRows().filter((row) => row.workspaceId === workspaceId))
}

export function orderAgentSessionsByTabs<T extends AgentSessionSummary>(input: { sessions: T[]; tabs: WorkspaceAgentTabRecord[] }): T[] {
  const activeSessions = input.sessions.filter((session) => session.status !== 'archived')
  const byId = new Map(activeSessions.map((session) => [session.id, session]))
  const ordered: T[] = []
  for (const tab of sortWorkspaceAgentTabRows(input.tabs)) {
    const session = byId.get(tab.sessionId)
    if (!session) continue
    ordered.push(session)
    byId.delete(tab.sessionId)
  }
  const missing = [...byId.values()].sort(compareSessionFallback)
  return [...ordered, ...missing]
}

function compareSessionFallback(a: AgentSessionSummary, b: AgentSessionSummary): number {
  const created = coerceTime(a.createdAt) - coerceTime(b.createdAt)
  return created || a.id.localeCompare(b.id)
}

function coerceTime(value: AgentSessionSummary['createdAt']): number {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}
