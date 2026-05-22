import { useMemo } from 'react'
import { workspacesCollection } from '../workspaces/collection'
import { workspaceFoldersCollection } from './collection'
import { buildWorkspaceSidebarTree } from './tree'
import type { WorkspaceFolderRecord, WorkspaceSidebarNode } from './types'

export function useWorkspaceFolders(): WorkspaceFolderRecord[] {
  const rows = workspaceFoldersCollection.useRows()
  return useMemo(() => rows.filter((row) => !row.archivedAt), [rows])
}

export function useWorkspaceSidebarTree(): WorkspaceSidebarNode[] {
  const workspaces = workspacesCollection.useRows()
  const folders = workspaceFoldersCollection.useRows()
  return useMemo(() => buildWorkspaceSidebarTree({ workspaces, folders }), [workspaces, folders])
}

export function getWorkspaceSidebarTree(): WorkspaceSidebarNode[] {
  return buildWorkspaceSidebarTree({ workspaces: workspacesCollection.getRows(), folders: workspaceFoldersCollection.getRows() })
}
