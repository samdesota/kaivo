import { appTrpcMutation } from '../../../lib/trpc-plain'
import {
  normalizeWorkspaceAgentTabRecord,
  workspaceAgentTabRecordKey,
  workspaceAgentTabsCollection,
  workspaceAgentTabsForWorkspace,
  workspaceAgentTabsSnapshot,
} from './collection'
import type { WorkspaceAgentTabRecord } from './types'

export async function ensureWorkspaceAgentTab(input: { workspaceId: string; sessionId: string }): Promise<void> {
  const before = workspaceAgentTabsCollection.getRows()
  const key = workspaceAgentTabRecordKey(input)
  if (before.some((row) => workspaceAgentTabRecordKey(row) === key)) return
  const record: WorkspaceAgentTabRecord = {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    position: nextWorkspaceAgentTabPosition(input.workspaceId, before),
    updatedAt: Date.now(),
  }
  workspaceAgentTabsCollection.applySnapshot(workspaceAgentTabsSnapshot([...before, record]))
  try {
    const saved = normalizeWorkspaceAgentTabRecord(await upsertAgentTabMutation(record))
    workspaceAgentTabsCollection.applySnapshot(workspaceAgentTabsSnapshot([
      ...workspaceAgentTabsCollection.getRows().filter((row) => workspaceAgentTabRecordKey(row) !== workspaceAgentTabRecordKey(saved)),
      saved,
    ]))
  } catch (error) {
    workspaceAgentTabsCollection.applySnapshot(workspaceAgentTabsSnapshot(before))
    throw error
  }
}

export async function deleteWorkspaceAgentTab(input: { workspaceId: string; sessionId: string }): Promise<void> {
  const before = workspaceAgentTabsCollection.getRows()
  const key = workspaceAgentTabRecordKey(input)
  if (!before.some((row) => workspaceAgentTabRecordKey(row) === key)) return
  workspaceAgentTabsCollection.applySnapshot(workspaceAgentTabsSnapshot(before.filter((row) => workspaceAgentTabRecordKey(row) !== key)))
  try {
    await appTrpcMutation('workspace.deleteAgentTab', input)
  } catch (error) {
    workspaceAgentTabsCollection.applySnapshot(workspaceAgentTabsSnapshot(before))
    throw error
  }
}

export async function reorderWorkspaceAgentTabs(input: { workspaceId: string; sessionIds: string[] }): Promise<void> {
  const before = workspaceAgentTabsCollection.getRows()
  const positionById = new Map(input.sessionIds.map((sessionId, index) => [sessionId, index]))
  const next = before.map((row) => {
    const position = row.workspaceId === input.workspaceId ? positionById.get(row.sessionId) : undefined
    return position === undefined || position === row.position ? row : { ...row, position, updatedAt: Date.now() }
  })
  workspaceAgentTabsCollection.applySnapshot(workspaceAgentTabsSnapshot(next))
  try {
    const records = workspaceAgentTabsForWorkspace(input.workspaceId).filter((row) => positionById.has(row.sessionId))
    await Promise.all(records.map((record) => upsertAgentTabMutation(record)))
  } catch (error) {
    workspaceAgentTabsCollection.applySnapshot(workspaceAgentTabsSnapshot(before))
    throw error
  }
}

export function applyWorkspaceAgentTabRowsForTests(rows: WorkspaceAgentTabRecord[]): void {
  workspaceAgentTabsCollection.applySnapshot(workspaceAgentTabsSnapshot(rows))
}

async function upsertAgentTabMutation(record: WorkspaceAgentTabRecord): Promise<unknown> {
  return await appTrpcMutation('workspace.upsertAgentTab', {
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    position: record.position,
  })
}

function nextWorkspaceAgentTabPosition(workspaceId: string, rows: WorkspaceAgentTabRecord[]): number {
  const positions = rows.filter((row) => row.workspaceId === workspaceId).map((row) => row.position)
  return positions.length === 0 ? 0 : Math.max(...positions) + 1
}
