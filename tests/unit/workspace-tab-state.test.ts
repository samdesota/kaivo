import { describe, expect, it } from 'vitest'
import { workspaceTabKey, type WorkspaceTab } from '../../shared/workspace-pane'
import { emptyWorkspaceUiState, updateFileEditorStateForTab, workspaceUiReducer } from '../../src/routes/workspace/tab-state'

describe('workspace tab state', () => {
  it('treats the same preview port in different envs as distinct', () => {
    const a: WorkspaceTab = { id: 'a', type: 'preview', envId: 'env-a', port: 3000, title: 'env-a :3000' }
    const b: WorkspaceTab = { id: 'b', type: 'preview', envId: 'env-b', port: 3000, title: 'env-b :3000' }

    expect(workspaceTabKey(a)).not.toBe(workspaceTabKey(b))
    let state = workspaceUiReducer(emptyWorkspaceUiState(), { type: 'openTab', tab: a })
    state = workspaceUiReducer(state, { type: 'openTab', tab: b })
    expect(state.workspaceTabs.map((tab) => tab.id)).toEqual(['a', 'b'])
  })

  it('workspace tab identity keys include envId for shell, file, and preview tabs', () => {
    expect(workspaceTabKey({ id: 's', type: 'shell', envId: 'env-a', shellId: 'shell-1', title: 'shell' })).toBe(
      'shell:env-a:shell-1',
    )
    expect(workspaceTabKey({ id: 'f', type: 'file', envId: 'env-a', path: '/tmp/a.ts', title: 'a.ts' })).toBe(
      'file:env-a::/tmp/a.ts',
    )
    expect(workspaceTabKey({ id: 'p', type: 'preview', envId: 'env-a', port: 3000, title: ':3000' })).toBe(
      'preview:env-a:3000',
    )
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
