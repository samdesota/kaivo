import { describe, expect, it } from 'vitest'
import {
  idleRenameEditState,
  nextRenameValue,
  renameEditReducer,
} from '../../src/routes/workspace/tab-bar-state'

describe('workspace tab bar rename state', () => {
  it('save/cancel transitions preserve newly created workspace identity', () => {
    let state = renameEditReducer(idleRenameEditState, {
      type: 'begin',
      workspaceId: 'workspace-new',
      name: 'Untitled workspace',
    })
    expect(state.editingId).toBe('workspace-new')

    state = renameEditReducer(state, { type: 'change', draft: 'My Workspace' })
    expect(nextRenameValue(state)).toBe('My Workspace')
    state = renameEditReducer(state, { type: 'saved' })
    expect(state).toEqual(idleRenameEditState)

    state = renameEditReducer(idleRenameEditState, {
      type: 'begin',
      workspaceId: 'workspace-new',
      name: 'Untitled workspace',
    })
    state = renameEditReducer(state, { type: 'change', draft: 'Cancelled name' })
    state = renameEditReducer(state, { type: 'cancel' })
    expect(state).toEqual(idleRenameEditState)
  })

  it('does not save empty or unchanged names', () => {
    let state = renameEditReducer(idleRenameEditState, {
      type: 'begin',
      workspaceId: 'workspace-a',
      name: 'Workspace A',
    })
    expect(nextRenameValue(state)).toBeNull()
    state = renameEditReducer(state, { type: 'change', draft: '   ' })
    expect(nextRenameValue(state)).toBeNull()
  })
})
