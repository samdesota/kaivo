import { workspaceTabKey } from '../../../../shared/workspace-pane'
import { defineSyncedCollection } from '../../sync/collection-factory'
import { registerAppSyncTable } from '../../sync/sync-registry'
import type { WorkspaceTab, WorkspaceTabRecord } from './types'

export const workspaceTabsCollection = defineSyncedCollection<WorkspaceTabRecord, string>({
  id: 'workspace-tabs',
  table: 'workspace_tabs',
  getKey: workspaceTabRecordKey,
  normalize: normalizeWorkspaceTabRecord,
})

registerAppSyncTable(workspaceTabsCollection)

export function workspaceTabRecordKey(record: Pick<WorkspaceTabRecord, 'workspaceId' | 'id'>): string {
  return JSON.stringify({ workspace_id: record.workspaceId, id: record.id })
}

export function normalizeWorkspaceTabRecord(raw: unknown): WorkspaceTabRecord {
  const row = raw as Partial<WorkspaceTabRecord> & Record<string, unknown>
  const type = row.type === 'shell' || row.type === 'file' || row.type === 'browser' || row.type === 'git-diff' ? row.type : 'browser'
  return {
    workspaceId: String(row.workspaceId),
    id: String(row.id),
    type,
    title: String(row.title ?? defaultTitle(type, row)),
    titleSource: row.titleSource === 'explicit' ? 'explicit' : row.titleSource === 'auto' ? 'auto' : null,
    position: Number(row.position ?? 0),
    envId: nullableString(row.envId),
    shellId: nullableString(row.shellId),
    path: nullableString(row.path),
    repoRoot: nullableString(row.repoRoot),
    sessionId: nullableString(row.sessionId),
    port: typeof row.port === 'number' ? row.port : null,
    url: nullableString(row.url),
    browserTabId: nullableString(row.browserTabId),
    faviconUrl: nullableString(row.faviconUrl),
    updatedAt: coerceTime(row.updatedAt),
  }
}

export function recordToWorkspaceTab(record: WorkspaceTabRecord): WorkspaceTab | null {
  if (record.type === 'shell' && record.envId && record.shellId) {
    return { id: record.id, type: 'shell', envId: record.envId, shellId: record.shellId, title: record.title, titleSource: record.titleSource ?? 'auto' }
  }
  if (record.type === 'file' && record.envId && record.path) {
    return { id: record.id, type: 'file', envId: record.envId, path: record.path, sessionId: record.sessionId ?? undefined, title: record.title }
  }
  if (record.type === 'git-diff' && record.envId && record.repoRoot) {
    return { id: record.id, type: 'git-diff', envId: record.envId, repoRoot: record.repoRoot, title: record.title }
  }
  if (record.type === 'browser' && record.url) {
    return { id: record.id, type: 'browser', url: record.url, browserTabId: record.browserTabId ?? undefined, faviconUrl: record.faviconUrl ?? undefined, title: record.title }
  }
  return null
}

export function workspaceTabToRecord(workspaceId: string, tab: WorkspaceTab, position: number): WorkspaceTabRecord {
  return {
    workspaceId,
    id: tab.id,
    type: tab.type,
    title: tab.title,
    titleSource: tab.type === 'shell' ? (tab.titleSource ?? 'auto') : null,
    position,
    envId: 'envId' in tab ? tab.envId : null,
    shellId: tab.type === 'shell' ? tab.shellId : null,
    path: tab.type === 'file' ? tab.path : null,
    repoRoot: tab.type === 'git-diff' ? tab.repoRoot : null,
    sessionId: tab.type === 'file' ? (tab.sessionId ?? null) : null,
    port: null,
    url: tab.type === 'browser' ? tab.url : null,
    browserTabId: tab.type === 'browser' ? (tab.browserTabId ?? null) : null,
    faviconUrl: tab.type === 'browser' ? (tab.faviconUrl ?? null) : null,
    updatedAt: Date.now(),
  }
}

export function compareWorkspaceTabRecords(a: WorkspaceTabRecord, b: WorkspaceTabRecord): number {
  return a.position - b.position || a.id.localeCompare(b.id)
}

export function sortWorkspaceTabRows(rows: WorkspaceTabRecord[]): WorkspaceTabRecord[] {
  return [...rows].sort(compareWorkspaceTabRecords)
}

export function workspaceTabsForWorkspace(workspaceId: string, rows = workspaceTabsCollection.getRows()): WorkspaceTabRecord[] {
  return sortWorkspaceTabRows(rows.filter((row) => row.workspaceId === workspaceId))
}

export function workspaceTabsSnapshot(rows = workspaceTabsCollection.getRows()): { table: 'workspace_tabs'; seq: number; rows: WorkspaceTabRecord[] } {
  return { table: 'workspace_tabs', seq: workspaceTabsCollection.getSeq(), rows }
}

export function findDuplicateWorkspaceTab(workspaceId: string, tab: WorkspaceTab, rows = workspaceTabsCollection.getRows()): WorkspaceTabRecord | null {
  const key = workspaceTabKey(tab)
  for (const record of workspaceTabsForWorkspace(workspaceId, rows)) {
    const current = recordToWorkspaceTab(record)
    if (current && workspaceTabKey(current) === key) return record
  }
  return null
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

function defaultTitle(type: WorkspaceTabRecord['type'], row: Partial<WorkspaceTabRecord> & Record<string, unknown>): string {
  if (type === 'shell') return `shell ${String(row.shellId ?? '').slice(-8)}`
  if (type === 'file') return String(row.path ?? 'File').split('/').pop() ?? 'File'
  if (type === 'git-diff') return 'Git Diff'
  return String(row.url ?? 'Browser')
}
