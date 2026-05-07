export type WorkspaceRollupState = 'attention' | 'running' | 'new_response' | 'idle'

export type WorkspaceChatSummary = {
  chatCount: number
  runningCount: number
  pendingAttentionCount: number
  newResponseCount: number
}

export function workspaceRollupState(summary: WorkspaceChatSummary): WorkspaceRollupState {
  if (summary.pendingAttentionCount > 0) return 'attention'
  if (summary.runningCount > 0) return 'running'
  if (summary.newResponseCount > 0) return 'new_response'
  return 'idle'
}

export function workspaceRollupGlyph(state: WorkspaceRollupState): string | null {
  if (state === 'attention') return '!'
  if (state === 'running') return '*'
  if (state === 'new_response') return '.'
  return null
}
