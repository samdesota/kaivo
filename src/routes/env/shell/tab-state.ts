import { useEffect, useReducer, useRef } from 'react'

export type PaneContent =
  | { type: 'shell'; shellId: string }
  | { type: 'file'; path: string; absolute?: boolean }
  | { type: 'browser'; url?: string; browserTabId?: string }

export interface Tab {
  id: string
  title: string
  titleSource?: 'auto' | 'explicit'
  content: PaneContent
}

export interface RightPaneState {
  tabs: Tab[]
  activeTabId: string
}

export type RightPaneAction =
  | { type: 'open'; content: PaneContent; title?: string; activate?: boolean }
  | { type: 'activate'; tabId: string }
  | { type: 'close'; tabId: string }
  | { type: 'setTitle'; tabId: string; title: string }
  | { type: 'setAutoTitle'; tabId: string; title: string }
  | { type: 'setBrowserTabId'; tabId: string; browserTabId: string }
  | { type: 'setBrowserUrl'; tabId: string; url: string }
  | { type: 'pruneShells'; liveShellIds: ReadonlySet<string> }
  | { type: 'reorder'; tabIds: string[] }
  | { type: 'hydrate'; state: RightPaneState }

function makeTabId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

export function defaultTitle(c: PaneContent): string {
  if (c.type === 'shell') return `shell ${c.shellId.slice(-6)}`
  if (c.type === 'file') {
    const parts = c.path.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? c.path
  }
  if (c.type === 'browser') return browserTitle(c)
  return 'Tab'
}

function sameContent(a: PaneContent, b: PaneContent): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'shell' && b.type === 'shell') return a.shellId === b.shellId
  if (a.type === 'file' && b.type === 'file')
    return a.path === b.path && !!a.absolute === !!b.absolute
  if (a.type === 'browser' && b.type === 'browser') {
    if (a.browserTabId && b.browserTabId) return a.browserTabId === b.browserTabId
    return (a.url ?? '') === (b.url ?? '')
  }
  return false
}

function browserTitle(c: Extract<PaneContent, { type: 'browser' }>): string {
  if (!c.url) return 'Browser'
  try {
    return new URL(c.url).hostname || c.url
  } catch {
    return c.url
  }
}

export function initialState(): RightPaneState {
  return { tabs: [], activeTabId: '' }
}

export function rightPaneReducer(state: RightPaneState, action: RightPaneAction): RightPaneState {
  switch (action.type) {
    case 'hydrate': {
      if (action.state.tabs.length === 0) return initialState()
      const ids = new Set(action.state.tabs.map((t) => t.id))
      const activeTabId = ids.has(action.state.activeTabId)
        ? action.state.activeTabId
        : (action.state.tabs[0]?.id ?? '')
      return { tabs: action.state.tabs, activeTabId: activeTabId ?? '' }
    }
    case 'open': {
      const existing = state.tabs.find((t) => sameContent(t.content, action.content))
      if (existing) {
        return action.activate === false ? state : { ...state, activeTabId: existing.id }
      }
      const tab: Tab = {
        id: makeTabId(),
        title: action.title ?? defaultTitle(action.content),
        titleSource: action.content.type === 'shell' ? (action.title ? 'explicit' : 'auto') : undefined,
        content: action.content,
      }
      const activate = action.activate !== false
      return {
        tabs: [...state.tabs, tab],
        activeTabId: activate ? tab.id : state.activeTabId,
      }
    }
    case 'activate': {
      if (!state.tabs.some((t) => t.id === action.tabId)) return state
      return { ...state, activeTabId: action.tabId }
    }
    case 'close': {
      const idx = state.tabs.findIndex((t) => t.id === action.tabId)
      if (idx < 0) return state
      const nextTabs = state.tabs.filter((t) => t.id !== action.tabId)
      if (nextTabs.length === 0) return { tabs: [], activeTabId: '' }
      let active = state.activeTabId
      if (action.tabId === state.activeTabId) {
        const neighbor = nextTabs[idx] ?? nextTabs[idx - 1] ?? nextTabs[0]
        active = neighbor?.id ?? ''
      }
      return { tabs: nextTabs, activeTabId: active }
    }
    case 'reorder': {
      const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]))
      const reordered = action.tabIds.map((id) => tabsById.get(id)).filter((tab): tab is Tab => Boolean(tab))
      if (reordered.length !== state.tabs.length) return state
      return { ...state, tabs: reordered }
    }
    case 'setTitle': {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId ? { ...t, title: action.title, titleSource: t.content.type === 'shell' ? 'explicit' : t.titleSource } : t,
        ),
      }
    }
    case 'setAutoTitle': {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId && t.content.type === 'shell' && t.titleSource !== 'explicit'
            ? { ...t, title: action.title, titleSource: 'auto' }
            : t,
        ),
      }
    }
    case 'setBrowserTabId': {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId && t.content.type === 'browser'
            ? { ...t, content: { ...t.content, browserTabId: action.browserTabId } }
            : t,
        ),
      }
    }
    case 'setBrowserUrl': {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId && t.content.type === 'browser'
            ? { ...t, content: { ...t.content, url: action.url } }
            : t,
        ),
      }
    }
    case 'pruneShells': {
      const keep = state.tabs.filter(
        (t) => t.content.type !== 'shell' || action.liveShellIds.has(t.content.shellId),
      )
      if (keep.length === state.tabs.length) return state
      if (keep.length === 0) return { tabs: [], activeTabId: '' }
      const activeStillThere = keep.some((t) => t.id === state.activeTabId)
      return {
        tabs: keep,
        activeTabId: activeStillThere ? state.activeTabId : (keep[0]?.id ?? ''),
      }
    }
    default:
      return state
  }
}

const STORAGE_VERSION = 1
interface StoredState {
  v: number
  state: RightPaneState
}

function storageKey(envId: string): string {
  return `env.${envId}.rightPane`
}

function loadStored(envId: string): RightPaneState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey(envId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredState
    if (parsed.v !== STORAGE_VERSION) return null
    if (!parsed.state || !Array.isArray(parsed.state.tabs)) return null
    const tabs = parsed.state.tabs.filter((t: unknown): t is Tab => {
      if (!t || typeof t !== 'object') return false
      const tt = t as Tab
      if (typeof tt.id !== 'string' || typeof tt.title !== 'string' || !tt.content) return false
      if (tt.titleSource !== undefined && tt.titleSource !== 'auto' && tt.titleSource !== 'explicit') return false
      const c = tt.content
      if (c.type === 'shell' && typeof c.shellId === 'string') return true
      if (c.type === 'file' && typeof c.path === 'string') return true
      if (c.type === 'browser') {
        return (
          (c.url === undefined || typeof c.url === 'string') &&
          (c.browserTabId === undefined || typeof c.browserTabId === 'string')
        )
      }
      return false
    })
    if (tabs.length === 0) return { tabs: [], activeTabId: '' }
    const activeTabId = tabs.some((t) => t.id === parsed.state.activeTabId)
      ? parsed.state.activeTabId
      : (tabs[0]?.id ?? '')
    return { tabs, activeTabId }
  } catch {
    return null
  }
}

function persist(envId: string, state: RightPaneState): void {
  if (typeof window === 'undefined') return
  try {
    const payload: StoredState = { v: STORAGE_VERSION, state }
    window.localStorage.setItem(storageKey(envId), JSON.stringify(payload))
  } catch {
    // Quota / disabled storage — silent; state still lives in memory.
  }
}

export function useRightPaneState(envId: string): [RightPaneState, React.Dispatch<RightPaneAction>] {
  const [state, dispatch] = useReducer(rightPaneReducer, undefined as unknown as RightPaneState, () => {
    const loaded = loadStored(envId)
    return loaded ?? initialState()
  })
  const lastEnvId = useRef(envId)

  useEffect(() => {
    if (lastEnvId.current !== envId) {
      lastEnvId.current = envId
      const loaded = loadStored(envId) ?? initialState()
      dispatch({ type: 'hydrate', state: loaded })
    }
  }, [envId])

  useEffect(() => {
    persist(envId, state)
  }, [envId, state])

  return [state, dispatch]
}
