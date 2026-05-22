import { defineSyncedCollection } from '../../sync/collection-factory'
import { registerAppSyncTable } from '../../sync/sync-registry'
import type { WorkspaceRecord } from './types'

export const workspacesCollection = defineSyncedCollection<WorkspaceRecord, string>({
  id: 'workspaces',
  table: 'workspaces',
  getKey: (row) => row.id,
  normalize: normalizeWorkspaceRecord,
})

registerAppSyncTable(workspacesCollection)

export function normalizeWorkspaceRecord(raw: unknown): WorkspaceRecord {
  const row = raw as Partial<WorkspaceRecord> & Record<string, unknown>
  return {
    id: String(row.id),
    name: String(row.name ?? 'Untitled workspace'),
    folderId: nullableString(row.folderId),
    position: Number(row.position ?? 0),
    nameSource: (row.nameSource as WorkspaceRecord['nameSource']) ?? 'explicit',
    sourceKind: (row.sourceKind as WorkspaceRecord['sourceKind']) ?? null,
    sourcePath: nullableString(row.sourcePath),
    kind: row.kind === 'system' ? 'system' : 'user',
    systemKey: nullableString(row.systemKey),
    hidden: Boolean(row.hidden),
    protected: Boolean(row.protected),
    createdAt: coerceTime(row.createdAt),
    updatedAt: coerceTime(row.updatedAt),
    lastOpenedAt: coerceNullableTime(row.lastOpenedAt),
    archivedAt: coerceNullableTime(row.archivedAt),
  }
}

export function sortWorkspaceRows(rows: WorkspaceRecord[]): WorkspaceRecord[] {
  return [...rows].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id.localeCompare(b.id)
  })
}

export function isVisibleWorkspace(row: WorkspaceRecord): boolean {
  return !row.archivedAt && row.kind !== 'system' && !row.hidden
}

export function workspaceRowsSnapshot(rows = workspacesCollection.getRows()): { table: 'workspaces'; seq: number; rows: WorkspaceRecord[] } {
  return { table: 'workspaces', seq: workspacesCollection.getSeq(), rows }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function coerceNullableTime(value: unknown): number | null {
  if (value == null) return null
  const time = coerceTime(value)
  return Number.isFinite(time) ? time : null
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
