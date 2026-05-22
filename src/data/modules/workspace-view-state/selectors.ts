import { useMemo } from 'react'
import { emptyWorkspaceViewState, workspaceViewStateCollection } from './collection'
import type { WorkspaceViewStateRecord } from './types'

export function useWorkspaceViewState(workspaceId: string): WorkspaceViewStateRecord {
  const rows = workspaceViewStateCollection.useRows()
  return useMemo(() => rows.find((row) => row.workspaceId === workspaceId) ?? emptyWorkspaceViewState(workspaceId), [rows, workspaceId])
}

export function getWorkspaceViewState(workspaceId: string): WorkspaceViewStateRecord {
  return workspaceViewStateCollection.getRows().find((row) => row.workspaceId === workspaceId) ?? emptyWorkspaceViewState(workspaceId)
}
