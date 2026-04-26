import { describe, expect, it } from 'vitest'
import {
  selectActiveWorkspaceSession,
  workspaceSessions,
} from '../../src/routes/env/agent/workspace-session-state'

describe('workspace session state', () => {
  it('chooses persisted workspace session when present and falls back safely', () => {
    const sessions = [
      { id: 'old', status: 'archived' },
      { id: 'first-active', status: 'active' },
      { id: 'persisted', status: 'active' },
    ]

    expect(selectActiveWorkspaceSession(sessions, 'persisted')).toBe('persisted')
    expect(selectActiveWorkspaceSession(sessions, 'missing')).toBe('first-active')
    expect(selectActiveWorkspaceSession([{ id: 'old', status: 'archived' }], 'old')).toBeNull()
  })

  it('separates two workspaces with sessions against the same env', () => {
    const sessions = [
      { id: 'a1', workspaceId: 'workspace-a', status: 'active' },
      { id: 'b1', workspaceId: 'workspace-b', status: 'active' },
      { id: 'a2', workspaceId: 'workspace-a', status: 'active' },
    ]

    expect(workspaceSessions(sessions, 'workspace-a').map((session) => session.id)).toEqual(['a1', 'a2'])
    expect(workspaceSessions(sessions, 'workspace-b').map((session) => session.id)).toEqual(['b1'])
  })
})
