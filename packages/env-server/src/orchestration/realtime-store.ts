import { randomUUID } from 'node:crypto'
import type { OrchestrationChange, OrchestrationCursor } from './contracts.js'

export class OrchestrationReplayBroker {
  private readonly generation = randomUUID()
  private readonly seqByWorkspace = new Map<string, number>()
  private readonly historyByWorkspace = new Map<string, OrchestrationChange[]>()

  constructor(private readonly historyLimit = 256) {}

  cursor(workspaceId: string): OrchestrationCursor {
    return { generation: this.generation, seq: this.seqByWorkspace.get(workspaceId) ?? 0 }
  }

  changes(workspaceId: string, cursor: OrchestrationCursor): OrchestrationChange[] {
    const current = this.cursor(workspaceId)
    if (cursor.generation !== this.generation) return [{ type: 'stale', cursor: current }]
    const history = this.historyByWorkspace.get(workspaceId) ?? []
    const firstSeq = history[0]?.cursor.seq ?? current.seq + 1
    if (cursor.seq < firstSeq - 1) return [{ type: 'stale', cursor: current }]
    return history.filter((change) => change.cursor.seq > cursor.seq)
  }

  publish(workspaceId: string): OrchestrationChange {
    const cursor = { generation: this.generation, seq: (this.seqByWorkspace.get(workspaceId) ?? 0) + 1 }
    this.seqByWorkspace.set(workspaceId, cursor.seq)
    const change: OrchestrationChange = { type: 'changed', cursor }
    const history = [...(this.historyByWorkspace.get(workspaceId) ?? []), change]
    if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit)
    this.historyByWorkspace.set(workspaceId, history)
    return change
  }
}
