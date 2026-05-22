export type WorkspaceRecord = {
  id: string
  name: string
  folderId: string | null
  position: number
  nameSource: 'explicit' | 'folder_path' | 'worktree' | 'derived'
  sourceKind: 'folder' | 'worktree' | 'repo_config' | null
  sourcePath: string | null
  kind: 'user' | 'system'
  systemKey: string | null
  hidden: boolean
  protected: boolean
  createdAt: number
  updatedAt: number
  lastOpenedAt: number | null
  archivedAt: number | null
}

export type CreateWorkspaceInput = {
  name?: string
  folderId?: string | null
  nameSource?: WorkspaceRecord['nameSource']
  sourceKind?: WorkspaceRecord['sourceKind']
  sourcePath?: string | null
}
