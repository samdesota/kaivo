export type RenameEditState = {
  editingId: string | null
  editingKind: 'workspace' | 'folder' | null
  draft: string
  original: string
}

export type RenameEditAction =
  | { type: 'begin'; workspaceId: string; name: string; kind?: 'workspace' | 'folder' }
  | { type: 'change'; draft: string }
  | { type: 'cancel' }
  | { type: 'saved' }

export const idleRenameEditState: RenameEditState = {
  editingId: null,
  editingKind: null,
  draft: '',
  original: '',
}

export function renameEditReducer(
  state: RenameEditState,
  action: RenameEditAction,
): RenameEditState {
  if (action.type === 'begin') {
    return { editingId: action.workspaceId, editingKind: action.kind ?? 'workspace', draft: action.name, original: action.name }
  }
  if (action.type === 'change') return { ...state, draft: action.draft }
  if (action.type === 'cancel' || action.type === 'saved') return idleRenameEditState
  return state
}

export function nextRenameValue(state: RenameEditState): string | null {
  const trimmed = state.draft.trim()
  if (!state.editingId || !trimmed || trimmed === state.original) return null
  return trimmed
}
