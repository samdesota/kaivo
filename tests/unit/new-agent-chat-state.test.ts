import { describe, expect, it } from 'vitest'
import {
  newAgentChatStartInput,
  validateNewAgentChatSelection,
} from '../../src/routes/env/agent/new-agent-chat-state'

describe('new agent chat state', () => {
  it('validates folder vs repo config selection without remote target state', () => {
    expect(validateNewAgentChatSelection(null)).toMatch(/choose/i)
    expect(validateNewAgentChatSelection({ type: 'folder', path: '   ' })).toMatch(/folder/i)
    expect(validateNewAgentChatSelection({ type: 'worktree', repoId: 'repo-1', path: '' })).toMatch(/work tree/i)
    expect(validateNewAgentChatSelection({ type: 'repoConfig', configId: '', worktreeName: 'demo' })).toMatch(/repo config/i)
    expect(validateNewAgentChatSelection({ type: 'repoConfig', configId: 'cfg-1', worktreeName: '' })).toMatch(/work tree/i)
    expect(validateNewAgentChatSelection({ type: 'folder', path: '/tmp/project' })).toBeNull()
    expect(validateNewAgentChatSelection({ type: 'worktree', repoId: 'repo-1', path: '/tmp/project' })).toBeNull()
    expect(validateNewAgentChatSelection({ type: 'repoConfig', configId: 'cfg-1', worktreeName: 'demo' })).toBeNull()
  })

  it('starts sessions with workspaceId and workingDir only', () => {
    expect(newAgentChatStartInput('workspace-a', '/tmp/project')).toEqual({
      workspaceId: 'workspace-a',
      directory: '/tmp/project',
    })
  })
})
