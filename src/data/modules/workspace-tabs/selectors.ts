import { useMemo } from 'react'
import { getWorkspaceViewState, useWorkspaceViewState } from '../workspace-view-state'
import { recordToWorkspaceTab, sortWorkspaceTabRows, workspaceTabsCollection } from './collection'
import type { WorkspaceTab, WorkspaceTabRecord } from './types'

export function useWorkspaceTabRecords(workspaceId: string): WorkspaceTabRecord[] {
  const rows = workspaceTabsCollection.useRows()
  return useMemo(() => sortWorkspaceTabRows(rows.filter((row) => row.workspaceId === workspaceId)), [rows, workspaceId])
}

export function useWorkspaceTabs(workspaceId: string): WorkspaceTab[] {
  const records = useWorkspaceTabRecords(workspaceId)
  return useMemo(() => records.map(recordToWorkspaceTab).filter((tab): tab is WorkspaceTab => Boolean(tab)), [records])
}

export function getWorkspaceTabs(workspaceId: string): WorkspaceTab[] {
  return sortWorkspaceTabRows(workspaceTabsCollection.getRows().filter((row) => row.workspaceId === workspaceId))
    .map(recordToWorkspaceTab)
    .filter((tab): tab is WorkspaceTab => Boolean(tab))
}

export function useActiveWorkspaceTab(workspaceId: string): WorkspaceTab | null {
  const tabs = useWorkspaceTabs(workspaceId)
  const viewState = useWorkspaceViewState(workspaceId)
  return useMemo(() => tabs.find((tab) => tab.id === viewState.activeWorkspaceTabId) ?? tabs[0] ?? null, [tabs, viewState.activeWorkspaceTabId])
}

export function getActiveWorkspaceTab(workspaceId: string): WorkspaceTab | null {
  const tabs = getWorkspaceTabs(workspaceId)
  const viewState = getWorkspaceViewState(workspaceId)
  return tabs.find((tab) => tab.id === viewState.activeWorkspaceTabId) ?? tabs[0] ?? null
}
