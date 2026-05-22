export type WorkspaceAgentTabRecord = {
  workspaceId: string
  sessionId: string
  position: number
  updatedAt: number
}

export type AgentSessionSummary = {
  id: string
  status?: string | null
  createdAt?: Date | string | number | null
}
