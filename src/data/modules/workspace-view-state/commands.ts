import { appTrpcMutation } from '../../../lib/trpc-plain'
import { emptyWorkspaceViewState, normalizeWorkspaceViewStateRecord, workspaceViewStateCollection, workspaceViewStateRowsSnapshot } from './collection'
import type { WorkspaceViewStatePatch, WorkspaceViewStateRecord } from './types'

export async function setActiveWorkspaceTab(input: { workspaceId: string; tabId: string | null }): Promise<void> {
  await updateWorkspaceViewState(input.workspaceId, { activeWorkspaceTabId: input.tabId })
}

export async function setActiveAgentSession(input: { workspaceId: string; sessionId: string | null }): Promise<void> {
  await updateWorkspaceViewState(input.workspaceId, { activeAgentSessionId: input.sessionId })
}

export async function setWorkspaceSplitRatio(input: { workspaceId: string; splitRatio: number | null }): Promise<void> {
  await updateWorkspaceViewState(input.workspaceId, { splitRatio: input.splitRatio })
}

export async function setAgentCollapsed(input: { workspaceId: string; collapsed: boolean }): Promise<void> {
  await updateWorkspaceViewState(input.workspaceId, { agentCollapsed: input.collapsed })
}

export async function updateWorkspaceViewState(workspaceId: string, patch: WorkspaceViewStatePatch): Promise<void> {
  const before = workspaceViewStateCollection.getRows()
  const current = before.find((row) => row.workspaceId === workspaceId) ?? emptyWorkspaceViewState(workspaceId)
  if (isNoopPatch(current, patch)) return
  const next: WorkspaceViewStateRecord = { ...current, ...patch, updatedAt: Date.now() }
  workspaceViewStateCollection.applySnapshot(workspaceViewStateRowsSnapshot([...before.filter((row) => row.workspaceId !== workspaceId), next]))
  try {
    const result = await appTrpcMutation('workspace.saveViewState', { workspaceId, state: patch })
    if (result && typeof result === 'object' && 'workspaceId' in result) {
      const saved = normalizeWorkspaceViewStateRecord(result)
      const latestRows = workspaceViewStateCollection.getRows()
      const latest = latestRows.find((row) => row.workspaceId === workspaceId) ?? emptyWorkspaceViewState(workspaceId)
      const merged = Object.keys(patch).reduce<WorkspaceViewStateRecord>(
        (row, key) => ({ ...row, [key]: saved[key as keyof WorkspaceViewStateRecord] }),
        { ...latest, updatedAt: saved.updatedAt },
      )
      workspaceViewStateCollection.applySnapshot(workspaceViewStateRowsSnapshot([...latestRows.filter((row) => row.workspaceId !== workspaceId), merged]))
    }
  } catch (error) {
    workspaceViewStateCollection.applySnapshot(workspaceViewStateRowsSnapshot(before))
    throw error
  }
}

export function applyWorkspaceViewStateRowsForTests(rows: WorkspaceViewStateRecord[]): void {
  workspaceViewStateCollection.applySnapshot(workspaceViewStateRowsSnapshot(rows))
}

function isNoopPatch(current: WorkspaceViewStateRecord, patch: WorkspaceViewStatePatch): boolean {
  return Object.entries(patch).every(([key, value]) => Object.is(current[key as keyof WorkspaceViewStateRecord], value))
}
