import { appTrpcMutation } from '../../../lib/trpc-plain'
import { normalizeWorkspaceRecord, workspacesCollection, workspaceRowsSnapshot } from './collection'
import type { CreateWorkspaceInput, WorkspaceRecord } from './types'

export async function createWorkspace(input: CreateWorkspaceInput = {}): Promise<WorkspaceRecord> {
  const before = workspacesCollection.getRows()
  const now = Date.now()
  const optimistic: WorkspaceRecord = {
    id: `optimistic-${crypto.randomUUID()}`,
    name: input.name?.trim() || 'Untitled workspace',
    folderId: input.folderId ?? null,
    position: nextPosition(before, input.folderId ?? null),
    nameSource: input.nameSource ?? 'explicit',
    sourceKind: input.sourceKind ?? null,
    sourcePath: input.sourcePath ?? null,
    kind: 'user',
    systemKey: null,
    hidden: false,
    protected: false,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: null,
    archivedAt: null,
  }
  workspacesCollection.applySnapshot(workspaceRowsSnapshot([...before, optimistic]))
  try {
    const created = normalizeWorkspaceRecord(await appTrpcMutation('workspace.create', input))
    workspacesCollection.applySnapshot(workspaceRowsSnapshot([...before.filter((row) => row.id !== created.id), created]))
    return created
  } catch (error) {
    workspacesCollection.applySnapshot(workspaceRowsSnapshot(before))
    throw error
  }
}

export async function renameWorkspace(input: { id: string; name: string }): Promise<void> {
  await optimisticWorkspacePatch(input.id, { name: input.name.trim() || 'Untitled workspace', updatedAt: Date.now() }, () => appTrpcMutation('workspace.rename', input))
}

export async function archiveWorkspace(id: string): Promise<void> {
  await optimisticWorkspacePatch(id, { archivedAt: Date.now(), updatedAt: Date.now() }, () => appTrpcMutation('workspace.archive', { id }))
}

export async function markWorkspaceOpened(id: string): Promise<void> {
  await optimisticWorkspacePatch(id, { lastOpenedAt: Date.now(), updatedAt: Date.now() }, () => appTrpcMutation('workspace.markOpened', { id }))
}

export function applyWorkspaceRowsForTests(rows: WorkspaceRecord[]): void {
  workspacesCollection.applySnapshot(workspaceRowsSnapshot(rows))
}

async function optimisticWorkspacePatch(id: string, patch: Partial<WorkspaceRecord>, call: () => Promise<unknown>): Promise<void> {
  const before = workspacesCollection.getRows()
  const next = before.map((row) => row.id === id ? { ...row, ...patch } : row)
  workspacesCollection.applySnapshot(workspaceRowsSnapshot(next))
  try {
    const result = await call()
    if (result && typeof result === 'object' && 'id' in result) {
      const updated = normalizeWorkspaceRecord(result)
      workspacesCollection.applySnapshot(workspaceRowsSnapshot(workspacesCollection.getRows().map((row) => row.id === updated.id ? updated : row)))
    }
  } catch (error) {
    workspacesCollection.applySnapshot(workspaceRowsSnapshot(before))
    throw error
  }
}

function nextPosition(rows: WorkspaceRecord[], folderId: string | null): number {
  const siblingPositions = rows.filter((row) => !row.archivedAt && (row.folderId ?? null) === folderId).map((row) => row.position)
  return siblingPositions.length === 0 ? 0 : Math.max(...siblingPositions) + 1
}
