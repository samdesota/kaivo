import type { WorkspaceRecord } from '../workspaces/types'

export type WorkspaceFolderRecord = {
  id: string
  parentId: string | null
  name: string
  position: number
  collapsed: boolean
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

export type WorkspaceSidebarNode =
  | { type: 'folder'; folder: WorkspaceFolderRecord; children: WorkspaceSidebarNode[] }
  | { type: 'workspace'; workspace: WorkspaceRecord }

export type MoveSidebarNodeInput = {
  nodeType: 'folder' | 'workspace'
  nodeId: string
  parentFolderId?: string | null
  beforeNodeId?: string | null
}
