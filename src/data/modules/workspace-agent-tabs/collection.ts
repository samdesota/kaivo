import { defineSyncedCollection } from '../../sync/collection-factory'
import { registerAppSyncTable } from '../../sync/sync-registry'
import type { WorkspaceAgentTabRecord } from './types'

export const workspaceAgentTabsCollection = defineSyncedCollection<WorkspaceAgentTabRecord, string>({
  id: 'workspace-agent-tabs',
  table: 'workspace_agent_tabs',
  getKey: workspaceAgentTabRecordKey,
  normalize: normalizeWorkspaceAgentTabRecord,
})

registerAppSyncTable(workspaceAgentTabsCollection)

export function workspaceAgentTabRecordKey(record: Pick<WorkspaceAgentTabRecord, 'workspaceId' | 'sessionId'>): string {
  return JSON.stringify({ workspace_id: record.workspaceId, session_id: record.sessionId })
}

export function normalizeWorkspaceAgentTabRecord(raw: unknown): WorkspaceAgentTabRecord {
  const row = raw as Partial<WorkspaceAgentTabRecord> & Record<string, unknown>
  return {
    workspaceId: String(row.workspaceId),
    sessionId: String(row.sessionId),
    position: Number(row.position ?? 0),
    updatedAt: coerceTime(row.updatedAt),
  }
}

export function compareWorkspaceAgentTabRecords(a: WorkspaceAgentTabRecord, b: WorkspaceAgentTabRecord): number {
  return a.position - b.position || a.sessionId.localeCompare(b.sessionId)
}

export function sortWorkspaceAgentTabRows(rows: WorkspaceAgentTabRecord[]): WorkspaceAgentTabRecord[] {
  return [...rows].sort(compareWorkspaceAgentTabRecords)
}

export function workspaceAgentTabsForWorkspace(workspaceId: string, rows = workspaceAgentTabsCollection.getRows()): WorkspaceAgentTabRecord[] {
  return sortWorkspaceAgentTabRows(rows.filter((row) => row.workspaceId === workspaceId))
}

export function workspaceAgentTabsSnapshot(rows = workspaceAgentTabsCollection.getRows()): { table: 'workspace_agent_tabs'; seq: number; rows: WorkspaceAgentTabRecord[] } {
  return { table: 'workspace_agent_tabs', seq: workspaceAgentTabsCollection.getSeq(), rows }
}

function coerceTime(value: unknown): number {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}
