export type WorkspaceViewStateRecord = {
  workspaceId: string
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  splitRatio: number | null
  agentCollapsed: boolean
  updatedAt: number
}

export type WorkspaceViewStatePatch = Partial<Pick<
  WorkspaceViewStateRecord,
  'activeAgentSessionId' | 'activeWorkspaceTabId' | 'splitRatio' | 'agentCollapsed'
>>
