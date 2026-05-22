import { defineSyncedCollection } from '../../sync/collection-factory'
import { registerAppSyncTable } from '../../sync/sync-registry'
import type { WorkspaceFolderRecord } from './types'

export const workspaceFoldersCollection = defineSyncedCollection<WorkspaceFolderRecord, string>({
  id: 'workspace-folders',
  table: 'workspace_folders',
  getKey: (row) => row.id,
  normalize: normalizeWorkspaceFolderRecord,
})

registerAppSyncTable(workspaceFoldersCollection)

export function normalizeWorkspaceFolderRecord(raw: unknown): WorkspaceFolderRecord {
  const row = raw as Partial<WorkspaceFolderRecord> & Record<string, unknown>
  return {
    id: String(row.id),
    parentId: typeof row.parentId === 'string' && row.parentId.length > 0 ? row.parentId : null,
    name: String(row.name ?? 'New folder'),
    position: Number(row.position ?? 0),
    collapsed: Boolean(row.collapsed),
    createdAt: coerceTime(row.createdAt),
    updatedAt: coerceTime(row.updatedAt),
    archivedAt: coerceNullableTime(row.archivedAt),
  }
}

export function sortFolderRows(rows: WorkspaceFolderRecord[]): WorkspaceFolderRecord[] {
  return [...rows].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id.localeCompare(b.id)
  })
}

export function folderRowsSnapshot(rows = workspaceFoldersCollection.getRows()): { table: 'workspace_folders'; seq: number; rows: WorkspaceFolderRecord[] } {
  return { table: 'workspace_folders', seq: workspaceFoldersCollection.getSeq(), rows }
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
