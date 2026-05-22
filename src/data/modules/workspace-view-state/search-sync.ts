import { useEffect, useRef } from 'react'
import type { WorkspaceTab } from '../workspace-tabs'
import { setActiveAgentSession, setActiveWorkspaceTab } from './commands'
import type { WorkspaceViewStateRecord } from './types'

export type WorkspaceSearchParams = {
  chat?: string
  tab?: string
}

export type WorkspaceSearchSyncAction =
  | { type: 'apply-search'; sessionId?: string; tabId?: string }
  | { type: 'replace-url'; chat?: string; tab?: string }
  | { type: 'none' }

export function workspaceSearchSyncAction(input: {
  firstApply: boolean
  search: WorkspaceSearchParams
  viewState: Pick<WorkspaceViewStateRecord, 'activeAgentSessionId' | 'activeWorkspaceTabId'>
  tabIds: string[]
}): WorkspaceSearchSyncAction {
  if (input.firstApply) {
    const action: Extract<WorkspaceSearchSyncAction, { type: 'apply-search' }> = { type: 'apply-search' }
    if (input.search.chat && input.search.chat !== input.viewState.activeAgentSessionId) {
      action.sessionId = input.search.chat
    }
    if (
      input.search.tab &&
      input.search.tab !== input.viewState.activeWorkspaceTabId &&
      input.tabIds.includes(input.search.tab)
    ) {
      action.tabId = input.search.tab
    }
    if (action.sessionId || action.tabId) return action
    return { type: 'none' }
  }

  if (
    input.viewState.activeWorkspaceTabId !== (input.search.tab ?? null) ||
    input.viewState.activeAgentSessionId !== (input.search.chat ?? null)
  ) {
    return {
      type: 'replace-url',
      chat: input.viewState.activeAgentSessionId ?? undefined,
      tab: input.viewState.activeWorkspaceTabId ?? undefined,
    }
  }

  return { type: 'none' }
}

export function useWorkspaceSearchSync(input: {
  workspaceId: string
  search: WorkspaceSearchParams
  viewState: WorkspaceViewStateRecord
  tabs: WorkspaceTab[]
  replaceSearch: (search: WorkspaceSearchParams) => void
  enabled?: boolean
}) {
  const { workspaceId, search, viewState, tabs, replaceSearch, enabled = true } = input
  const appliedWorkspaceId = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    const firstApply = appliedWorkspaceId.current !== workspaceId
    if (firstApply) appliedWorkspaceId.current = workspaceId

    if (
      viewState.activeWorkspaceTabId &&
      !tabs.some((tab) => tab.id === viewState.activeWorkspaceTabId)
    ) {
      void setActiveWorkspaceTab({ workspaceId, tabId: tabs[0]?.id ?? null })
      return
    }

    const action = workspaceSearchSyncAction({
      firstApply,
      search,
      viewState,
      tabIds: tabs.map((tab) => tab.id),
    })
    if (action.type === 'apply-search') {
      if (action.sessionId) void setActiveAgentSession({ workspaceId, sessionId: action.sessionId })
      if (action.tabId) void setActiveWorkspaceTab({ workspaceId, tabId: action.tabId })
    } else if (action.type === 'replace-url') {
      replaceSearch({ chat: action.chat, tab: action.tab })
    }
  }, [enabled, replaceSearch, search, tabs, viewState, workspaceId])
}
