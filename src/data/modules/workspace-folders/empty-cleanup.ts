import type { WorkspaceRecord } from '../workspaces/types'
import type { WorkspaceFolderRecord } from './types'

export function removeEmptyWorkspaceFolderAncestors(input: {
  folders: WorkspaceFolderRecord[]
  workspaces: WorkspaceRecord[]
  startFolderId: string | null | undefined
}): WorkspaceFolderRecord[] {
  let folderId = input.startFolderId ?? null
  if (!folderId) return input.folders

  const folders = [...input.folders]
  while (folderId) {
    const folder = folders.find((row) => row.id === folderId && !row.archivedAt)
    if (!folder) break
    const hasChildFolder = folders.some((row) => !row.archivedAt && (row.parentId ?? null) === folderId)
    const hasWorkspace = input.workspaces.some((row) => !row.archivedAt && (row.folderId ?? null) === folderId)
    if (hasChildFolder || hasWorkspace) break
    const index = folders.findIndex((row) => row.id === folderId)
    if (index >= 0) folders.splice(index, 1)
    folderId = folder.parentId ?? null
  }
  return folders
}
