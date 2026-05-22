import { useMemo } from 'react'
import { isVisibleWorkspace, sortWorkspaceRows, workspacesCollection } from './collection'
import type { WorkspaceRecord } from './types'

export function useWorkspaces(): WorkspaceRecord[] {
  const rows = workspacesCollection.useRows()
  return useMemo(() => sortWorkspaceRows(rows.filter((row) => !row.archivedAt)), [rows])
}

export function useVisibleWorkspaces(): WorkspaceRecord[] {
  const rows = workspacesCollection.useRows()
  return useMemo(() => sortWorkspaceRows(rows.filter(isVisibleWorkspace)), [rows])
}

export function useWorkspace(workspaceId: string): WorkspaceRecord | null {
  const rows = workspacesCollection.useRows()
  return useMemo(() => rows.find((row) => row.id === workspaceId && !row.archivedAt) ?? null, [rows, workspaceId])
}

export function getWorkspace(workspaceId: string): WorkspaceRecord | null {
  return workspacesCollection.getRows().find((row) => row.id === workspaceId && !row.archivedAt) ?? null
}

export function getVisibleWorkspaces(): WorkspaceRecord[] {
  return sortWorkspaceRows(workspacesCollection.getRows().filter(isVisibleWorkspace))
}
