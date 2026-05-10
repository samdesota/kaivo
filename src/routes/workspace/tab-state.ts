import { workspaceTabKey, type WorkspaceTab } from '../../../shared/workspace-pane'
import type { FileEditorState } from '../env/file-editor-state'

export type { WorkspaceTab }
export { workspaceTabKey }

export type WorkspaceUiState = {
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  workspaceTabs: WorkspaceTab[]
  splitRatio: number | null
  agentCollapsed: boolean
  tabOrder: string[]
}

export type WorkspaceUiAction =
  | { type: 'hydrate'; state: WorkspaceUiState }
  | { type: 'openTab'; tab: WorkspaceTab; activate?: boolean }
  | { type: 'activateTab'; tabId: string }
  | { type: 'closeTab'; tabId: string }
  | { type: 'setBrowserTabId'; tabId: string; browserTabId: string }
  | { type: 'setTabUrl'; tabId: string; url: string }
  | { type: 'setTabTitle'; tabId: string; title: string }
  | { type: 'setTabAutoTitle'; tabId: string; title: string }
  | { type: 'setActiveAgentSession'; sessionId: string | null }
  | { type: 'setSplitRatio'; splitRatio: number | null }
  | { type: 'setAgentCollapsed'; collapsed: boolean }

export type FileEditorStatesByTabId = Record<string, FileEditorState>

export function updateFileEditorStateForTab(
  states: FileEditorStatesByTabId,
  tabId: string,
  editorState: FileEditorState,
): FileEditorStatesByTabId {
  return {
    ...states,
    [tabId]: editorState,
  }
}

export function emptyWorkspaceUiState(): WorkspaceUiState {
  return {
    activeAgentSessionId: null,
    activeWorkspaceTabId: null,
    workspaceTabs: [],
    splitRatio: null,
    agentCollapsed: false,
    tabOrder: [],
  }
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
  if (action.type === 'setAgentCollapsed') return { ...state, agentCollapsed: action.collapsed }
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
  if (action.type === 'setTabUrl') {
    return {
      ...state,
      workspaceTabs: state.workspaceTabs.map((tab) =>
        tab.id === action.tabId && tab.type === 'browser'
          ? { ...tab, url: action.url }
          : tab,
      ),
    }
  }
  if (action.type === 'setTabTitle') {
    return {
      ...state,
      workspaceTabs: state.workspaceTabs.map((tab) =>
        tab.id === action.tabId
          ? tab.type === 'shell'
            ? { ...tab, title: action.title, titleSource: 'explicit' }
            : { ...tab, title: action.title }
          : tab,
      ),
    }
  }
  if (action.type === 'setTabAutoTitle') {
    return {
      ...state,
      workspaceTabs: state.workspaceTabs.map((tab) =>
        tab.id === action.tabId && tab.type === 'shell' && tab.titleSource !== 'explicit'
          ? { ...tab, title: action.title, titleSource: 'auto' }
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
    agentCollapsed: state.agentCollapsed ?? false,
    tabOrder: state.workspaceTabs.map((tab) => tab.id),
  }
}
