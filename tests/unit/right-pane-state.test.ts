import { beforeEach, describe, expect, it } from 'vitest'
import {
  initialState,
  rightPaneReducer,
  type PaneContent,
  type RightPaneState,
} from '../../src/routes/sandbox/shell/tab-state.js'

function open(state: RightPaneState, content: PaneContent, activate = true): RightPaneState {
  return rightPaneReducer(state, { type: 'open', content, activate })
}

describe('rightPaneReducer', () => {
  let state: RightPaneState
  beforeEach(() => {
    state = initialState()
  })

  it('starts empty (no tabs)', () => {
    expect(state.tabs).toHaveLength(0)
    expect(state.activeTabId).toBe('')
  })

  it('opens a shell tab and activates it by default', () => {
    const s1 = open(state, { type: 'shell', shellId: 'abc123' })
    expect(s1.tabs).toHaveLength(1)
    const shell = s1.tabs[0]!
    expect(shell.title).toBe('shell abc123')
    expect(s1.activeTabId).toBe(shell.id)
  })

  it('reuses an existing tab when opening the same shell again', () => {
    const s1 = open(state, { type: 'shell', shellId: 'abc' })
    const s2 = open(s1, { type: 'shell', shellId: 'abc' })
    expect(s2.tabs).toHaveLength(1)
    expect(s2.activeTabId).toBe(s1.tabs[0]!.id)
  })

  it('file and preview tabs dedupe by path and port', () => {
    let s = open(state, { type: 'file', path: '/src/a.ts' })
    s = open(s, { type: 'file', path: '/src/a.ts' })
    s = open(s, { type: 'preview', port: 5173 })
    s = open(s, { type: 'preview', port: 5173 })
    const kinds = s.tabs.map((t) => t.content.type).sort()
    expect(kinds).toEqual(['file', 'preview'])
  })

  it('closing the active tab activates a neighbor', () => {
    let s = open(state, { type: 'shell', shellId: 'a' })
    s = open(s, { type: 'shell', shellId: 'b' })
    const tabB = s.tabs.find((t) => t.content.type === 'shell' && t.content.shellId === 'b')!
    expect(s.activeTabId).toBe(tabB.id)
    const s2 = rightPaneReducer(s, { type: 'close', tabId: tabB.id })
    expect(s2.tabs).toHaveLength(1)
    const tabA = s2.tabs.find((t) => t.content.type === 'shell' && t.content.shellId === 'a')!
    expect(s2.activeTabId).toBe(tabA.id)
  })

  it('closing the last tab leaves the pane empty', () => {
    const s1 = open(state, { type: 'file', path: '/a.ts' })
    const s2 = rightPaneReducer(s1, { type: 'close', tabId: s1.tabs[0]!.id })
    expect(s2.tabs).toHaveLength(0)
    expect(s2.activeTabId).toBe('')
  })

  it('setTitle updates the named tab only', () => {
    const s1 = open(state, { type: 'shell', shellId: 'x' })
    const s2 = open(s1, { type: 'file', path: '/a.ts' })
    const shellTab = s2.tabs.find((t) => t.content.type === 'shell')!
    const s3 = rightPaneReducer(s2, { type: 'setTitle', tabId: shellTab.id, title: 'build' })
    expect(s3.tabs.find((t) => t.id === shellTab.id)?.title).toBe('build')
    expect(s3.tabs.find((t) => t.content.type === 'file')?.title).toBe('a.ts')
  })

  it('pruneShells drops shell tabs whose shell is no longer live', () => {
    let s = open(state, { type: 'shell', shellId: 'alive' })
    s = open(s, { type: 'shell', shellId: 'dead' })
    const pruned = rightPaneReducer(s, {
      type: 'pruneShells',
      liveShellIds: new Set(['alive']),
    })
    expect(pruned.tabs.some((t) => t.content.type === 'shell' && t.content.shellId === 'dead')).toBe(false)
    expect(pruned.tabs.some((t) => t.content.type === 'shell' && t.content.shellId === 'alive')).toBe(true)
  })

  it('pruneShells leaves non-shell tabs alone', () => {
    let s = open(state, { type: 'file', path: '/a.ts' })
    s = open(s, { type: 'preview', port: 3000 })
    const pruned = rightPaneReducer(s, { type: 'pruneShells', liveShellIds: new Set() })
    expect(pruned.tabs).toHaveLength(2)
  })

  it('hydrate adopts a stored state when valid', () => {
    const stored: RightPaneState = {
      tabs: [
        { id: 'x', title: 'x', content: { type: 'shell', shellId: 'x' } },
        { id: 'y', title: 'a.ts', content: { type: 'file', path: '/a.ts' } },
      ],
      activeTabId: 'y',
    }
    const s = rightPaneReducer(state, { type: 'hydrate', state: stored })
    expect(s.tabs.map((t) => t.id)).toEqual(['x', 'y'])
    expect(s.activeTabId).toBe('y')
  })

  it('hydrate falls back if activeTabId is missing from stored tabs', () => {
    const stored: RightPaneState = {
      tabs: [{ id: 'x', title: 'x', content: { type: 'shell', shellId: 'x' } }],
      activeTabId: 'not-there',
    }
    const s = rightPaneReducer(state, { type: 'hydrate', state: stored })
    expect(s.activeTabId).toBe('x')
  })

  it('hydrate of empty state stays empty', () => {
    const s = rightPaneReducer(state, {
      type: 'hydrate',
      state: { tabs: [], activeTabId: '' },
    })
    expect(s.tabs).toHaveLength(0)
    expect(s.activeTabId).toBe('')
  })
})
