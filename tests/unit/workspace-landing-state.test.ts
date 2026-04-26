import { describe, expect, it } from 'vitest'
import { chooseWorkspaceLandingAction } from '../../src/routes/workspace-landing-state'

describe('workspace landing state', () => {
  it('opens the most recent workspace when one exists', () => {
    expect(
      chooseWorkspaceLandingAction(false, [{ id: 'workspace-recent' }, { id: 'workspace-old' }]),
    ).toEqual({ type: 'open', workspaceId: 'workspace-recent' })
  })

  it('creates an initial workspace for fresh profiles', () => {
    expect(chooseWorkspaceLandingAction(false, [])).toEqual({ type: 'create' })
  })

  it('waits while loading', () => {
    expect(chooseWorkspaceLandingAction(true, undefined)).toEqual({ type: 'wait' })
  })
})
