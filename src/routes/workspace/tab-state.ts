export type WorkspaceTab =
  | { id: string; type: 'shell'; envId: string; shellId: string; title: string }
  | { id: string; type: 'file'; envId: string; path: string; sessionId?: string; title: string }
  | { id: string; type: 'preview'; envId: string; port: number; title: string }
  | { id: string; type: 'browser'; url: string; browserTabId?: string; title: string }

export type WorkspaceUiState = {
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  workspaceTabs: WorkspaceTab[]
  splitRatio: number | null
  tabOrder: string[]
}

export type WorkspaceUiAction =
  | { type: 'hydrate'; state: WorkspaceUiState }
  | { type: 'openTab'; tab: WorkspaceTab; activate?: boolean }
  | { type: 'activateTab'; tabId: string }
  | { type: 'closeTab'; tabId: string }
  | { type: 'setBrowserTabId'; tabId: string; browserTabId: string }
  | { type: 'setActiveAgentSession'; sessionId: string | null }
  | { type: 'setSplitRatio'; splitRatio: number | null }

export function emptyWorkspaceUiState(): WorkspaceUiState {
  return {
    activeAgentSessionId: null,
    activeWorkspaceTabId: null,
    workspaceTabs: [],
    splitRatio: null,
    tabOrder: [],
  }
}

export function workspaceTabKey(tab: WorkspaceTab): string {
  if (tab.type === 'shell') return `shell:${tab.envId}:${tab.shellId}`
  if (tab.type === 'file') return `file:${tab.envId}:${tab.sessionId ?? ''}:${tab.path}`
  if (tab.type === 'preview') return `preview:${tab.envId}:${tab.port}`
  return `browser:${tab.url}`
}

export function workspaceUiReducer(
  state: WorkspaceUiState,
  action: WorkspaceUiAction,
): WorkspaceUiState {
  if (action.type === 'hydrate') return normalizeState(action.state)
  if (action.type === 'setActiveAgentSession') {
    return { ...state, activeAgentSessionId: action.sessionId }
  }
  if (action.type === 'setSplitRatio') return { ...state, splitRatio: action.splitRatio }
  if (action.type === 'activateTab') {
    return state.workspaceTabs.some((tab) => tab.id === action.tabId)
      ? { ...state, activeWorkspaceTabId: action.tabId }
      : state
  }
  if (action.type === 'openTab') {
    const existing = state.workspaceTabs.find((tab) => workspaceTabKey(tab) === workspaceTabKey(action.tab))
    const tabs = existing ? state.workspaceTabs : [...state.workspaceTabs, action.tab]
    const activeWorkspaceTabId = action.activate === false ? state.activeWorkspaceTabId : (existing?.id ?? action.tab.id)
    return normalizeState({ ...state, workspaceTabs: tabs, activeWorkspaceTabId })
  }
  if (action.type === 'closeTab') {
    const idx = state.workspaceTabs.findIndex((tab) => tab.id === action.tabId)
    if (idx === -1) return state
    const tabs = state.workspaceTabs.filter((tab) => tab.id !== action.tabId)
    let activeWorkspaceTabId = state.activeWorkspaceTabId
    if (activeWorkspaceTabId === action.tabId) {
      activeWorkspaceTabId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null
    }
    return normalizeState({ ...state, workspaceTabs: tabs, activeWorkspaceTabId })
  }
  if (action.type === 'setBrowserTabId') {
    return {
      ...state,
      workspaceTabs: state.workspaceTabs.map((tab) =>
        tab.id === action.tabId && tab.type === 'browser'
          ? { ...tab, browserTabId: action.browserTabId }
          : tab,
      ),
    }
  }
  return state
}

function normalizeState(state: WorkspaceUiState): WorkspaceUiState {
  const activeWorkspaceTabId = state.workspaceTabs.some((tab) => tab.id === state.activeWorkspaceTabId)
    ? state.activeWorkspaceTabId
    : (state.workspaceTabs[0]?.id ?? null)
  return {
    activeAgentSessionId: state.activeAgentSessionId ?? null,
    activeWorkspaceTabId,
    workspaceTabs: state.workspaceTabs,
    splitRatio: state.splitRatio,
    tabOrder: state.workspaceTabs.map((tab) => tab.id),
  }
}
