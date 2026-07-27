import { AGENT_SESSION_RUNTIME_TABLE, getAgentRuntimeRealtime } from '../agent/runtime-realtime.js'
import { getEnvRealtime } from '../realtime/env-realtime.js'
import type { OrchestrationChange, OrchestrationCursor } from './contracts.js'
import { OrchestrationReplayBroker } from './realtime-store.js'

type Listener = (workspaceId: string, change: OrchestrationChange) => void

const DURABLE_TABLES = ['agent_sessions', 'orchestration_subtasks', 'orchestration_returns']
export class OrchestrationRealtime {
  private readonly broker = new OrchestrationReplayBroker()
  private readonly listeners = new Set<Listener>()
  private started = false

  constructor(private readonly connectSources = true) {}

  start(): void {
    if (this.started) return
    this.started = true
    if (!this.connectSources) return
    getEnvRealtime().subscribe((events) => {
      const workspaces = new Set<string>()
      for (const event of events) {
        if (!DURABLE_TABLES.includes(event.table) || !event.row) continue
        const row = event.row as { workspaceId?: unknown; kind?: unknown }
        if (event.table === 'agent_sessions' && row.kind !== 'dispatch' && row.kind !== 'subtask') continue
        if (typeof row.workspaceId === 'string') workspaces.add(row.workspaceId)
      }
      for (const workspaceId of workspaces) this.publish(workspaceId)
    })
    getAgentRuntimeRealtime().subscribe((events) => {
      const workspaces = new Set<string>()
      for (const event of events) {
        if (event.table !== AGENT_SESSION_RUNTIME_TABLE || !event.row) continue
        const workspaceId = (event.row as { workspaceId?: unknown }).workspaceId
        if (typeof workspaceId === 'string') workspaces.add(workspaceId)
      }
      for (const workspaceId of workspaces) this.publish(workspaceId)
    })
  }

  cursor(workspaceId: string): OrchestrationCursor {
    this.start()
    return this.broker.cursor(workspaceId)
  }

  changes(workspaceId: string, cursor: OrchestrationCursor): OrchestrationChange[] {
    this.start()
    return this.broker.changes(workspaceId, cursor)
  }

  subscribe(listener: Listener): () => void {
    this.start()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(workspaceId: string): OrchestrationChange {
    const change = this.broker.publish(workspaceId)
    for (const listener of this.listeners) listener(workspaceId, change)
    return change
  }
}

let orchestrationRealtime: OrchestrationRealtime | null = null

export function getOrchestrationRealtime(): OrchestrationRealtime {
  if (!orchestrationRealtime) orchestrationRealtime = new OrchestrationRealtime()
  return orchestrationRealtime
}
