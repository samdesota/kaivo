export type NewAgentChatSelection =
  | { type: 'folder'; path: string }
  | { type: 'repoConfig'; configId: string }

export function validateNewAgentChatSelection(
  selection: NewAgentChatSelection | null,
): string | null {
  if (!selection) return 'Choose a folder or repo config.'
  if (selection.type === 'folder' && !selection.path.trim()) return 'Choose a folder.'
  if (selection.type === 'repoConfig' && !selection.configId.trim()) return 'Choose a repo config.'
  return null
}

export function newAgentChatStartInput(workspaceId: string, workingDir: string) {
  return { workspaceId, directory: workingDir }
}
