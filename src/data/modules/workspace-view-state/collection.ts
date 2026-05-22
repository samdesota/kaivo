import { defineSyncedCollection } from '../../sync/collection-factory'
import { registerAppSyncTable } from '../../sync/sync-registry'
import type { WorkspaceViewStateRecord } from './types'

export const workspaceViewStateCollection = defineSyncedCollection<WorkspaceViewStateRecord, string>({
  id: 'workspace-view-state',
  table: 'workspace_view_states',
  getKey: (row) => row.workspaceId,
  normalize: normalizeWorkspaceViewStateRecord,
})

registerAppSyncTable(workspaceViewStateCollection)

export function normalizeWorkspaceViewStateRecord(raw: unknown): WorkspaceViewStateRecord {
  const row = raw as Partial<WorkspaceViewStateRecord> & Record<string, unknown>
  return {
    workspaceId: String(row.workspaceId),
    activeAgentSessionId: nullableString(row.activeAgentSessionId),
    activeWorkspaceTabId: nullableString(row.activeWorkspaceTabId),
    splitRatio: typeof row.splitRatio === 'number' ? row.splitRatio : null,
    agentCollapsed: Boolean(row.agentCollapsed),
    updatedAt: coerceTime(row.updatedAt),
  }
}

export function emptyWorkspaceViewState(workspaceId: string): WorkspaceViewStateRecord {
  return {
    workspaceId,
    activeAgentSessionId: null,
    activeWorkspaceTabId: null,
    splitRatio: null,
    agentCollapsed: false,
    updatedAt: Date.now(),
  }
}

export function workspaceViewStateRowsSnapshot(rows = workspaceViewStateCollection.getRows()): { table: 'workspace_view_states'; seq: number; rows: WorkspaceViewStateRecord[] } {
  return { table: 'workspace_view_states', seq: workspaceViewStateCollection.getSeq(), rows }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
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
