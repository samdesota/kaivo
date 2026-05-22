import { workspaceTabKey } from '../../../../shared/workspace-pane'
import { appTrpcMutation } from '../../../lib/trpc-plain'
import { setActiveWorkspaceTab } from '../workspace-view-state'
import {
  compareWorkspaceTabRecords,
  findDuplicateWorkspaceTab,
  normalizeWorkspaceTabRecord,
  recordToWorkspaceTab,
  workspaceTabRecordKey,
  workspaceTabsCollection,
  workspaceTabsForWorkspace,
  workspaceTabsSnapshot,
  workspaceTabToRecord,
} from './collection'
import type { WorkspaceTab, WorkspaceTabRecord } from './types'

export async function openWorkspaceTab(input: { workspaceId: string; tab: WorkspaceTab; activate?: boolean }): Promise<WorkspaceTab> {
  const before = workspaceTabsCollection.getRows()
  const existing = findDuplicateWorkspaceTab(input.workspaceId, input.tab, before)
  if (existing) {
    if (input.activate !== false) await setActiveWorkspaceTab({ workspaceId: input.workspaceId, tabId: existing.id })
    return recordToWorkspaceTab(existing) ?? input.tab
  }
  const position = nextWorkspaceTabPosition(input.workspaceId, before)
  const record = workspaceTabToRecord(input.workspaceId, input.tab, position)
  workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot([...before, record]))
  if (input.activate !== false) await setActiveWorkspaceTab({ workspaceId: input.workspaceId, tabId: record.id })
  void upsertWorkspaceTabRecord(record, before)
  return input.tab
}

export async function closeWorkspaceTab(input: { workspaceId: string; tabId: string; activateFallback?: boolean }): Promise<string | null> {
  const before = workspaceTabsCollection.getRows()
  const records = workspaceTabsForWorkspace(input.workspaceId, before)
  const idx = records.findIndex((record) => record.id === input.tabId)
  if (idx === -1) return records[0]?.id ?? null
  const remainingRecords = records.filter((record) => record.id !== input.tabId)
  const fallbackTabId = remainingRecords[idx]?.id ?? remainingRecords[idx - 1]?.id ?? null
  workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot(before.filter((row) => !(row.workspaceId === input.workspaceId && row.id === input.tabId))))
  if (input.activateFallback !== false) await setActiveWorkspaceTab({ workspaceId: input.workspaceId, tabId: fallbackTabId })
  try {
    await appTrpcMutation('workspace.deleteTab', { workspaceId: input.workspaceId, tabId: input.tabId })
  } catch (error) {
    workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot(before))
    throw error
  }
  return fallbackTabId
}

export async function reorderWorkspaceTabs(input: { workspaceId: string; tabIds: string[] }): Promise<void> {
  const before = workspaceTabsCollection.getRows()
  const order = new Map(input.tabIds.map((id, index) => [id, index]))
  const next = before.map((row) => row.workspaceId === input.workspaceId && order.has(row.id) ? { ...row, position: order.get(row.id)!, updatedAt: Date.now() } : row)
  workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot(next))
  try {
    const records = workspaceTabsForWorkspace(input.workspaceId).filter((row) => order.has(row.id))
    await Promise.all(records.map((record) => upsertTabMutation(record)))
  } catch (error) {
    workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot(before))
    throw error
  }
}

export async function setWorkspaceTabBrowserId(input: { workspaceId: string; tabId: string; browserTabId: string }): Promise<void> {
  await updateWorkspaceTabRecord(input.workspaceId, input.tabId, (row) => row.type === 'browser' ? { ...row, browserTabId: input.browserTabId, updatedAt: Date.now() } : row)
}

export async function setWorkspaceTabUrl(input: { workspaceId: string; tabId: string; url: string }): Promise<void> {
  await updateWorkspaceTabRecord(input.workspaceId, input.tabId, (row) => row.type === 'browser' ? { ...row, url: input.url, updatedAt: Date.now() } : row)
}

export async function setWorkspaceTabTitle(input: { workspaceId: string; tabId: string; title: string; source?: 'auto' | 'explicit' }): Promise<void> {
  await updateWorkspaceTabRecord(input.workspaceId, input.tabId, (row) => {
    if (input.source === 'auto' && row.type === 'shell' && row.titleSource === 'explicit') return row
    return { ...row, title: input.title, titleSource: row.type === 'shell' ? (input.source ?? 'explicit') : row.titleSource, updatedAt: Date.now() }
  })
}

export function nextActiveWorkspaceTabIdAfterClose(tabs: WorkspaceTab[], activeTabId: string | null, closingTabId: string): string | null {
  if (activeTabId !== closingTabId) return activeTabId && tabs.some((tab) => tab.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null)
  const idx = tabs.findIndex((tab) => tab.id === closingTabId)
  const remaining = tabs.filter((tab) => tab.id !== closingTabId)
  return remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null
}

export function applyWorkspaceTabRowsForTests(rows: WorkspaceTabRecord[]): void {
  workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot(rows))
}

async function updateWorkspaceTabRecord(workspaceId: string, tabId: string, update: (row: WorkspaceTabRecord) => WorkspaceTabRecord): Promise<void> {
  const before = workspaceTabsCollection.getRows()
  const current = before.find((row) => row.workspaceId === workspaceId && row.id === tabId)
  if (!current) return
  const updated = update(current)
  if (updated === current) return
  workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot(before.map((row) => row.workspaceId === workspaceId && row.id === tabId ? updated : row)))
  try {
    await upsertTabMutation(updated)
  } catch (error) {
    workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot(before))
    throw error
  }
}

async function upsertWorkspaceTabRecord(record: WorkspaceTabRecord, before: WorkspaceTabRecord[]): Promise<void> {
  try {
    const saved = normalizeWorkspaceTabRecord(await upsertTabMutation(record))
    workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot([...workspaceTabsCollection.getRows().filter((row) => workspaceTabRecordKey(row) !== workspaceTabRecordKey(saved)), saved]))
  } catch (error) {
    workspaceTabsCollection.applySnapshot(workspaceTabsSnapshot(before))
    throw error
  }
}

async function upsertTabMutation(record: WorkspaceTabRecord): Promise<unknown> {
  const tab = recordToWorkspaceTab(record)
  if (!tab) return null
  return await appTrpcMutation('workspace.upsertTab', { workspaceId: record.workspaceId, tab, position: record.position })
}

function nextWorkspaceTabPosition(workspaceId: string, rows: WorkspaceTabRecord[]): number {
  const positions = rows.filter((row) => row.workspaceId === workspaceId).map((row) => row.position)
  return positions.length === 0 ? 0 : Math.max(...positions) + 1
}

export function workspaceTabKeyForTests(tab: WorkspaceTab): string {
  return workspaceTabKey(tab)
}

export function sortWorkspaceTabRowsForTests(rows: WorkspaceTabRecord[]): WorkspaceTabRecord[] {
  return [...rows].sort(compareWorkspaceTabRecords)
}
