import { isVisibleWorkspace } from '../workspaces/collection'
import type { WorkspaceRecord } from '../workspaces/types'
import { sortFolderRows } from './collection'
import type { WorkspaceFolderRecord, WorkspaceSidebarNode } from './types'

export function buildWorkspaceSidebarTree(input: { workspaces: WorkspaceRecord[]; folders: WorkspaceFolderRecord[] }): WorkspaceSidebarNode[] {
  const activeFolders = sortFolderRows(input.folders.filter((folder) => !folder.archivedAt))
  const folderNodes = new Map<string, Extract<WorkspaceSidebarNode, { type: 'folder' }>>()
  for (const folder of activeFolders) folderNodes.set(folder.id, { type: 'folder', folder, children: [] })

  const roots: WorkspaceSidebarNode[] = []
  for (const folder of activeFolders) {
    const node = folderNodes.get(folder.id)
    if (!node) continue
    const parent = folder.parentId ? folderNodes.get(folder.parentId) : null
    if (parent && parent.folder.id !== folder.id) parent.children.push(node)
    else roots.push(node)
  }

  for (const workspace of sortWorkspaceRows(input.workspaces.filter(isVisibleWorkspace))) {
    const node: WorkspaceSidebarNode = { type: 'workspace', workspace }
    const parent = workspace.folderId ? folderNodes.get(workspace.folderId) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  sortNodes(roots)
  return roots
}

function sortWorkspaceRows(rows: WorkspaceRecord[]): WorkspaceRecord[] {
  return [...rows].sort(compareTreeRows)
}

function sortNodes(nodes: WorkspaceSidebarNode[]): void {
  nodes.sort((a, b) => compareTreeRows(a.type === 'folder' ? a.folder : a.workspace, b.type === 'folder' ? b.folder : b.workspace))
  for (const node of nodes) if (node.type === 'folder') sortNodes(node.children)
}

function compareTreeRows(a: { position: number; createdAt: number; id: string }, b: { position: number; createdAt: number; id: string }): number {
  if (a.position !== b.position) return a.position - b.position
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id.localeCompare(b.id)
}
