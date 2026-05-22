import { appTrpcMutation } from '../../../lib/trpc-plain'
import { workspacesCollection, workspaceRowsSnapshot } from '../workspaces/collection'
import { folderRowsSnapshot, normalizeWorkspaceFolderRecord, workspaceFoldersCollection } from './collection'
import type { MoveSidebarNodeInput, WorkspaceFolderRecord, WorkspaceSidebarNode } from './types'

export async function createWorkspaceFolder(input: { name: string; parentId?: string | null }): Promise<WorkspaceFolderRecord> {
  const before = workspaceFoldersCollection.getRows()
  const now = Date.now()
  const optimistic: WorkspaceFolderRecord = {
    id: `optimistic-${crypto.randomUUID()}`,
    parentId: input.parentId ?? null,
    name: input.name.trim() || 'New folder',
    position: nextFolderPosition(before, input.parentId ?? null),
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  }
  workspaceFoldersCollection.applySnapshot(folderRowsSnapshot([...before, optimistic]))
  try {
    const created = normalizeWorkspaceFolderRecord(await appTrpcMutation('workspace.createFolder', input))
    workspaceFoldersCollection.applySnapshot(folderRowsSnapshot([...before.filter((row) => row.id !== created.id), created]))
    return created
  } catch (error) {
    workspaceFoldersCollection.applySnapshot(folderRowsSnapshot(before))
    throw error
  }
}

export async function renameWorkspaceFolder(input: { id: string; name: string }): Promise<void> {
  await optimisticFolderPatch(input.id, { name: input.name.trim() || 'New folder', updatedAt: Date.now() }, () => appTrpcMutation('workspace.renameFolder', input))
}

export async function archiveWorkspaceFolder(id: string): Promise<void> {
  await optimisticFolderPatch(id, { archivedAt: Date.now(), updatedAt: Date.now() }, () => appTrpcMutation('workspace.archiveFolder', { id }))
}

export async function setWorkspaceFolderCollapsed(input: { id: string; collapsed: boolean }): Promise<void> {
  await optimisticFolderPatch(input.id, { collapsed: input.collapsed, updatedAt: Date.now() }, () => appTrpcMutation('workspace.setFolderCollapsed', input))
}

export async function moveWorkspaceSidebarNode(input: MoveSidebarNodeInput): Promise<void> {
  const beforeFolders = workspaceFoldersCollection.getRows()
  const beforeWorkspaces = workspacesCollection.getRows()
  applyOptimisticMove(input)
  try {
    const tree = await appTrpcMutation<WorkspaceSidebarNode[]>('workspace.moveSidebarNode', input)
    if (Array.isArray(tree)) applyTreeRows(tree)
  } catch (error) {
    workspaceFoldersCollection.applySnapshot(folderRowsSnapshot(beforeFolders))
    workspacesCollection.applySnapshot(workspaceRowsSnapshot(beforeWorkspaces))
    throw error
  }
}

export function applyWorkspaceFolderRowsForTests(rows: WorkspaceFolderRecord[]): void {
  workspaceFoldersCollection.applySnapshot(folderRowsSnapshot(rows))
}

async function optimisticFolderPatch(id: string, patch: Partial<WorkspaceFolderRecord>, call: () => Promise<unknown>): Promise<void> {
  const before = workspaceFoldersCollection.getRows()
  workspaceFoldersCollection.applySnapshot(folderRowsSnapshot(before.map((row) => row.id === id ? { ...row, ...patch } : row)))
  try {
    const result = await call()
    if (result && typeof result === 'object' && 'id' in result) {
      const updated = normalizeWorkspaceFolderRecord(result)
      workspaceFoldersCollection.applySnapshot(folderRowsSnapshot(workspaceFoldersCollection.getRows().map((row) => row.id === updated.id ? updated : row)))
    }
  } catch (error) {
    workspaceFoldersCollection.applySnapshot(folderRowsSnapshot(before))
    throw error
  }
}

function applyOptimisticMove(input: MoveSidebarNodeInput): void {
  const parentFolderId = input.parentFolderId ?? null
  const before = parseBeforeNodeId(input.beforeNodeId)
  const folders = workspaceFoldersCollection.getRows()
  const workspaces = workspacesCollection.getRows()
  const now = Date.now()
  const siblings = [
    ...folders.filter((row) => !row.archivedAt && (row.parentId ?? null) === parentFolderId).map((row) => ({ kind: 'folder' as const, id: row.id })),
    ...workspaces.filter((row) => !row.archivedAt && (row.folderId ?? null) === parentFolderId).map((row) => ({ kind: 'workspace' as const, id: row.id })),
  ].filter((row) => !(row.kind === input.nodeType && row.id === input.nodeId))
  const index = before ? siblings.findIndex((row) => row.kind === before.kind && row.id === before.id) : -1
  siblings.splice(before && index >= 0 ? index : siblings.length, 0, { kind: input.nodeType, id: input.nodeId })

  const positions = new Map(siblings.map((row, position) => [`${row.kind}:${row.id}`, position]))
  workspaceFoldersCollection.applySnapshot(folderRowsSnapshot(folders.map((row) => {
    if (input.nodeType === 'folder' && row.id === input.nodeId) return { ...row, parentId: parentFolderId, position: positions.get(`folder:${row.id}`) ?? row.position, updatedAt: now }
    const position = positions.get(`folder:${row.id}`)
    return position == null ? row : { ...row, position, updatedAt: now }
  })))
  workspacesCollection.applySnapshot(workspaceRowsSnapshot(workspaces.map((row) => {
    if (input.nodeType === 'workspace' && row.id === input.nodeId) return { ...row, folderId: parentFolderId, position: positions.get(`workspace:${row.id}`) ?? row.position, updatedAt: now }
    const position = positions.get(`workspace:${row.id}`)
    return position == null ? row : { ...row, position, updatedAt: now }
  })))
}

function applyTreeRows(nodes: WorkspaceSidebarNode[]): void {
  const folders: WorkspaceFolderRecord[] = []
  const workspaceRows = [...workspacesCollection.getRows()]
  const workspaceById = new Map(workspaceRows.map((row) => [row.id, row]))
  function visit(nodeList: WorkspaceSidebarNode[]) {
    for (const node of nodeList) {
      if (node.type === 'folder') {
        folders.push(normalizeWorkspaceFolderRecord(node.folder))
        visit(node.children)
      } else {
        workspaceById.set(node.workspace.id, node.workspace)
      }
    }
  }
  visit(nodes)
  workspaceFoldersCollection.applySnapshot(folderRowsSnapshot(folders))
  workspacesCollection.applySnapshot(workspaceRowsSnapshot([...workspaceById.values()]))
}

function parseBeforeNodeId(beforeNodeId?: string | null): { kind: 'folder' | 'workspace'; id: string } | null {
  if (!beforeNodeId) return null
  const [kind, ...rest] = beforeNodeId.split(':')
  if ((kind !== 'folder' && kind !== 'workspace') || rest.length === 0) return null
  return { kind, id: rest.join(':') }
}

function nextFolderPosition(rows: WorkspaceFolderRecord[], parentId: string | null): number {
  const siblingPositions = rows.filter((row) => !row.archivedAt && (row.parentId ?? null) === parentId).map((row) => row.position)
  return siblingPositions.length === 0 ? 0 : Math.max(...siblingPositions) + 1
}
