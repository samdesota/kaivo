export type NewAgentChatSelection =
  | { type: 'folder'; path: string }
  | { type: 'worktree'; repoId: string; path: string; name?: string }
  | { type: 'repoConfig'; configId: string; worktreeName: string }

export type NewAgentChatWorkspaceMode = 'new' | 'existing'
export type NewAgentChatWorkspaceNameSource = 'explicit' | 'folder_path' | 'worktree'

export type WorkspaceNameDraft = {
  value: string
  edited: boolean
}

export type ResolvedWorkspaceName = {
  name: string
  source: NewAgentChatWorkspaceNameSource
}

export type NewAgentChatCreatePlan =
  | {
      mode: 'existing'
      sessionStart: ReturnType<typeof newAgentChatStartInput>
    }
  | {
      mode: 'new'
      workspaceCreate: {
        name: string
        folderId?: string | null
        nameSource: NewAgentChatWorkspaceNameSource
        sourceKind: 'folder' | 'worktree' | 'repo_config'
        sourcePath: string
      }
      sessionDirectory: string | null
    }

export function validateNewAgentChatSelection(
  selection: NewAgentChatSelection | null,
): string | null {
  if (!selection) return 'Choose a folder, work tree, or repo config.'
  if (selection.type === 'folder' && !selection.path.trim()) return 'Choose a folder.'
  if (selection.type === 'worktree' && !selection.path.trim()) return 'Choose a work tree.'
  if (selection.type === 'repoConfig' && !selection.configId.trim()) return 'Choose a repo config.'
  if (selection.type === 'repoConfig' && !selection.worktreeName.trim()) return 'Name the work tree.'
  return null
}

export function newAgentChatWorkingDir(selection: NewAgentChatSelection): string | null {
  if (selection.type === 'folder') return selection.path.trim() || null
  if (selection.type === 'worktree') return selection.path.trim() || null
  return null
}

export function defaultWorkspaceName(selection: NewAgentChatSelection | null): ResolvedWorkspaceName {
  if (!selection) return { name: 'Untitled workspace', source: 'explicit' }
  if (selection.type === 'folder') {
    const path = selection.path.trim()
    return { name: folderName(path) || path || 'Untitled workspace', source: 'folder_path' }
  }
  if (selection.type === 'worktree') {
    const name = selection.name?.trim() || folderName(selection.path.trim()) || 'Untitled workspace'
    return { name, source: 'worktree' }
  }
  return { name: selection.worktreeName.trim() || 'Untitled workspace', source: 'worktree' }
}

export function resolveWorkspaceName(
  selection: NewAgentChatSelection | null,
  draft: WorkspaceNameDraft,
): ResolvedWorkspaceName {
  const generated = defaultWorkspaceName(selection)
  const value = draft.value.trim()
  if (!draft.edited || !value) return generated
  return { name: value, source: 'explicit' }
}

export function newAgentChatCreatePlan(input: {
  mode: NewAgentChatWorkspaceMode
  existingWorkspaceId?: string
  folderId?: string | null
  selection: NewAgentChatSelection
  workspaceNameDraft?: WorkspaceNameDraft
}): NewAgentChatCreatePlan {
  const workingDir = newAgentChatWorkingDir(input.selection)
  const directory = workingDir
  if (input.mode === 'existing') {
    if (!input.existingWorkspaceId) throw new Error('existing workspace id is required')
    if (!directory) throw new Error('working directory is required')
    return { mode: 'existing', sessionStart: newAgentChatStartInput(input.existingWorkspaceId, directory) }
  }
  const resolvedName = resolveWorkspaceName(input.selection, input.workspaceNameDraft ?? { value: '', edited: false })
  const sourceKind = input.selection.type === 'folder' ? 'folder' : input.selection.type === 'worktree' ? 'worktree' : 'repo_config'
  const sourcePath = input.selection.type === 'repoConfig' ? input.selection.worktreeName.trim() : input.selection.path.trim()
  return {
    mode: 'new',
    workspaceCreate: {
      name: resolvedName.name,
      folderId: input.folderId ?? null,
      nameSource: resolvedName.source,
      sourceKind,
      sourcePath,
    },
    sessionDirectory: directory,
  }
}

export function newAgentChatStartInput(workspaceId: string, workingDir: string) {
  return { workspaceId, directory: workingDir }
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}
