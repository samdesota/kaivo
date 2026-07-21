import { describe, expect, it } from 'vitest'
import { workspaceTabKey, type WorkspaceTab } from '../../shared/workspace-pane'
import { emptyWorkspaceUiState, updateFileEditorStateForTab, workspaceUiReducer } from '../../src/routes/workspace/tab-state'

describe('workspace tab state', () => {
  it('treats the same file path in different envs as distinct', () => {
    const a: WorkspaceTab = { id: 'a', type: 'file', envId: 'env-a', path: '/tmp/a.ts', title: 'env-a a.ts' }
    const b: WorkspaceTab = { id: 'b', type: 'file', envId: 'env-b', path: '/tmp/a.ts', title: 'env-b a.ts' }

    expect(workspaceTabKey(a)).not.toBe(workspaceTabKey(b))
    let state = workspaceUiReducer(emptyWorkspaceUiState(), { type: 'openTab', tab: a })
    state = workspaceUiReducer(state, { type: 'openTab', tab: b })
    expect(state.workspaceTabs.map((tab) => tab.id)).toEqual(['a', 'b'])
  })

  it('workspace tab identity keys include envId for shell and file tabs', () => {
    expect(workspaceTabKey({ id: 's', type: 'shell', envId: 'env-a', shellId: 'shell-1', title: 'shell' })).toBe(
      'shell:env-a:shell-1',
    )
    expect(workspaceTabKey({ id: 'f', type: 'file', envId: 'env-a', path: '/tmp/a.ts', title: 'a.ts' })).toBe(
      'file:env-a::/tmp/a.ts',
    )
  })

  it('restores git diff tabs and deduplicates them by env and repository root', () => {
    const tab: WorkspaceTab = { id: 'diff-1', type: 'git-diff', envId: 'env-a', repoRoot: '/repo', title: 'Git Diff' }
    let state = workspaceUiReducer(emptyWorkspaceUiState(), {
      type: 'hydrate',
      state: { ...emptyWorkspaceUiState(), workspaceTabs: [tab], activeWorkspaceTabId: 'diff-1' },
    })
    state = workspaceUiReducer(state, {
      type: 'openTab',
      tab: { ...tab, id: 'diff-2' },
    })

    expect(state.workspaceTabs).toEqual([tab])
    expect(state.activeWorkspaceTabId).toBe('diff-1')
  })

  it('restores active chat, active workspace tab, split ratio, and agent collapsed state from persisted state', () => {
    const state = workspaceUiReducer(emptyWorkspaceUiState(), {
      type: 'hydrate',
      state: {
        activeAgentSessionId: 'agent-1',
        activeWorkspaceTabId: 'tab-1',
        workspaceTabs: [{ id: 'tab-1', type: 'browser', url: 'https://example.com', title: 'Example' }],
        splitRatio: 0.42,
        agentCollapsed: true,
        tabOrder: ['tab-1'],
      },
    })

    expect(state.activeAgentSessionId).toBe('agent-1')
    expect(state.activeWorkspaceTabId).toBe('tab-1')
    expect(state.splitRatio).toBe(0.42)
    expect(state.agentCollapsed).toBe(true)
  })

  it('updates agent collapsed state independently from tab state', () => {
    const state = workspaceUiReducer(emptyWorkspaceUiState(), {
      type: 'setAgentCollapsed',
      collapsed: true,
    })

    expect(state.agentCollapsed).toBe(true)
    expect(state.workspaceTabs).toEqual([])
  })

  it('stores native browser tab id for browser workspace tabs', () => {
    let state = workspaceUiReducer(emptyWorkspaceUiState(), {
      type: 'openTab',
      tab: { id: 'browser-1', type: 'browser', url: 'https://example.com', title: 'Example' },
    })
    state = workspaceUiReducer(state, {
      type: 'setBrowserTabId',
      tabId: 'browser-1',
      browserTabId: 'native-1',
    })
    expect(state.workspaceTabs[0]).toMatchObject({ browserTabId: 'native-1' })
  })

  it('stores current URL for browser workspace tabs', () => {
    let state = workspaceUiReducer(emptyWorkspaceUiState(), {
      type: 'openTab',
      tab: { id: 'browser-1', type: 'browser', url: 'https://example.com', title: 'Example' },
    })
    state = workspaceUiReducer(state, {
      type: 'setTabUrl',
      tabId: 'browser-1',
      url: 'https://example.org/docs',
    })
    expect(state.workspaceTabs[0]).toMatchObject({ url: 'https://example.org/docs' })
  })

  it('updates file editor state for the target tab only', () => {
    const states = {
      'file-a': { draft: 'local a', draftBaseMtime: '2026-05-07T00:00:00.000Z' },
      'file-b': { draft: 'local b', draftBaseMtime: '2026-05-07T00:00:01.000Z' },
    }

    const next = updateFileEditorStateForTab(states, 'file-a', {
      draft: 'updated a',
      draftBaseMtime: '2026-05-07T00:00:02.000Z',
    })

    expect(next['file-a']).toEqual({
      draft: 'updated a',
      draftBaseMtime: '2026-05-07T00:00:02.000Z',
    })
    expect(next['file-b']).toBe(states['file-b'])
  })
})
