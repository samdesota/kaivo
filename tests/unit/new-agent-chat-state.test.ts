import { describe, expect, it } from 'vitest'
import {
  defaultWorkspaceName,
  newAgentChatCreatePlan,
  newAgentChatStartInput,
  resolveWorkspaceName,
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

  it('derives default workspace names from folder and worktree selections', () => {
    expect(defaultWorkspaceName({ type: 'folder', path: '/tmp/zoottle' })).toEqual({
      name: 'zoottle',
      source: 'folder_path',
    })
    expect(defaultWorkspaceName({ type: 'worktree', repoId: 'repo-1', path: '/tmp/project/bug-fix', name: 'bug-fix' })).toEqual({
      name: 'bug-fix',
      source: 'worktree',
    })
    expect(defaultWorkspaceName({ type: 'repoConfig', configId: 'cfg-1', worktreeName: 'sidebar-folders' })).toEqual({
      name: 'sidebar-folders',
      source: 'worktree',
    })
  })

  it('uses edited workspace names but restores generated preview when cleared', () => {
    const selection = { type: 'folder' as const, path: '/tmp/zoottle' }

    expect(resolveWorkspaceName(selection, { value: 'Custom Project', edited: true })).toEqual({
      name: 'Custom Project',
      source: 'explicit',
    })
    expect(resolveWorkspaceName(selection, { value: '   ', edited: true })).toEqual({
      name: 'zoottle',
      source: 'folder_path',
    })
  })

  it('distinguishes new workspace creation from existing workspace chat creation', () => {
    expect(newAgentChatCreatePlan({
      mode: 'existing',
      existingWorkspaceId: 'workspace-a',
      selection: { type: 'folder', path: '/tmp/project' },
    })).toEqual({
      mode: 'existing',
      sessionStart: { workspaceId: 'workspace-a', directory: '/tmp/project' },
    })

    expect(newAgentChatCreatePlan({
      mode: 'new',
      folderId: 'folder-a',
      selection: { type: 'folder', path: '/tmp/project' },
      workspaceNameDraft: { value: '', edited: false },
    })).toEqual({
      mode: 'new',
      workspaceCreate: {
        name: 'project',
        folderId: 'folder-a',
        nameSource: 'folder_path',
        sourceKind: 'folder',
        sourcePath: '/tmp/project',
      },
      sessionDirectory: '/tmp/project',
    })
  })
})
