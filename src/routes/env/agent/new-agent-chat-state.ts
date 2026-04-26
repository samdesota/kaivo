export type NewAgentChatSelection =
  | { type: 'folder'; path: string }
  | { type: 'worktree'; repoId: string; path: string }
  | { type: 'repoConfig'; configId: string; worktreeName: string }

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

export function newAgentChatStartInput(workspaceId: string, workingDir: string) {
  return { workspaceId, directory: workingDir }
}
