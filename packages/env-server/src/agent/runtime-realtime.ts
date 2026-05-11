import { InMemoryRealtimeStore } from '../realtime/in-memory-realtime.js'

export const AGENT_SESSION_RUNTIME_TABLE = 'agent_session_runtime'

export type AgentSessionRuntimeRow = {
  sessionId: string
  workspaceId: string | null
  running: boolean
  pendingAttentionCount: number
  lastActivityAt: string
  updatedAt: string
}

let agentRuntimeRealtime: InMemoryRealtimeStore | null = null

export function getAgentRuntimeRealtime(): InMemoryRealtimeStore {
  if (!agentRuntimeRealtime) {
    agentRuntimeRealtime = new InMemoryRealtimeStore([{ table: AGENT_SESSION_RUNTIME_TABLE, key: 'sessionId' }])
  }
  return agentRuntimeRealtime
}
