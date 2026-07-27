import { eq } from 'drizzle-orm'
import { agentService, type TranscriptEvent } from '../agent/service.js'
import { db } from '../db/client.js'
import { agentSessions } from '../db/schema.js'
import { logger } from '../logger.js'
import { orchestrationService, type OrchestrationService } from './service.js'
import { terminalReturnFromMessage, type CanonicalMessage } from './terminal-turn.js'
import { returnNotificationMirror, type ReturnNotificationMirror } from './return-notification-mirror.js'

interface ObserverAgent {
  subscribeEvents(listener: (event: TranscriptEvent) => void): () => void
  subscribeSessionSends(listener: (sessionId: string) => void): () => void
  subscribeSessionCreated(listener: (session: { kind: string; workingDir: string | null }) => void): () => void
  retainEventStream(directory: string): () => void
  openCodeSessionMessages(sessionId: string): Promise<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>
}

export interface ReturnReconciliationOutcome {
  opencodeSessionId: string
  outcome: 'reconciled' | 'failed'
  durationMs: number
  error?: string
}

export class OrchestrationTurnObserver {
  private started = false
  private releases: Array<() => void> = []
  private pending = new Map<string, Promise<void>>()

  constructor(
    private readonly orchestration: OrchestrationService = orchestrationService,
    private readonly agent: ObserverAgent = agentService,
    private readonly notifications: Pick<ReturnNotificationMirror, 'drain'> = returnNotificationMirror,
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.releases.push(this.agent.subscribeEvents((event) => this.onEvent(event)))
    this.releases.push(this.agent.subscribeSessionSends((sessionId) => {
      this.orchestration.resumeReturnedSubtask(sessionId)
    }))
    this.releases.push(this.agent.subscribeSessionCreated((session) => {
      if (session.kind === 'subtask') this.releases.push(this.agent.retainEventStream(session.workingDir ?? ''))
    }))
    const directories = new Set(db.select({ workingDir: agentSessions.workingDir }).from(agentSessions)
      .where(eq(agentSessions.kind, 'subtask')).all().map((row) => row.workingDir ?? ''))
    for (const directory of directories) this.releases.push(this.agent.retainEventStream(directory))
  }

  stop(): void {
    for (const release of this.releases.splice(0)) release()
    this.started = false
  }

  async reconcileOpencodeSession(opencodeSessionId: string): Promise<void> {
    const subtask = this.orchestration.subtaskForOpencodeSession(opencodeSessionId)
    if (!subtask) return
    const messages = await this.agent.openCodeSessionMessages(subtask.sessionId)
    for (const message of messages as CanonicalMessage[]) {
      const value = terminalReturnFromMessage(message)
      if (value) this.orchestration.recordReturn(subtask.id, value)
    }
    await this.notifications.drain()
  }

  async reconcileAll(concurrency = 4): Promise<ReturnReconciliationOutcome[]> {
    const sessions = db.select({ opencodeSessionId: agentSessions.opencodeSessionId }).from(agentSessions)
      .where(eq(agentSessions.kind, 'subtask')).all()
    const outcomes: ReturnReconciliationOutcome[] = []
    let index = 0
    const worker = async () => {
      while (index < sessions.length) {
        const session = sessions[index++]!
        const startedAt = Date.now()
        try {
          await this.reconcileOpencodeSession(session.opencodeSessionId)
          outcomes.push({
            opencodeSessionId: session.opencodeSessionId,
            outcome: 'reconciled',
            durationMs: Date.now() - startedAt,
          })
        } catch (err) {
          outcomes.push({
            opencodeSessionId: session.opencodeSessionId,
            outcome: 'failed',
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), sessions.length) }, worker))
    return outcomes
  }

  async observeEvent(event: TranscriptEvent): Promise<void> {
    if (!this.isTerminalSignal(event)) return
    await this.reconcileOpencodeSession(event.sessionId)
  }

  private onEvent(event: TranscriptEvent): void {
    if (!this.isTerminalSignal(event)) return
    this.enqueue(event.sessionId)
  }

  private isTerminalSignal(event: TranscriptEvent): boolean {
    if (event.parentSessionId) return false
    if (event.type === 'message.updated') {
      const info = (event.payload as { info?: Record<string, unknown> }).info
      const time = info?.time && typeof info.time === 'object' ? info.time as Record<string, unknown> : null
      if (time?.completed == null && info?.finish == null && info?.error == null) return false
    } else if (event.type !== 'session.idle' && event.type !== 'session.error') {
      return false
    }
    return true
  }

  private enqueue(opencodeSessionId: string): void {
    const previous = this.pending.get(opencodeSessionId) ?? Promise.resolve()
    const next = previous.then(() => this.reconcileOpencodeSession(opencodeSessionId))
      .catch((err) => logger.warn({ err, opencodeSessionId }, 'orchestration turn reconciliation failed'))
      .finally(() => {
        if (this.pending.get(opencodeSessionId) === next) this.pending.delete(opencodeSessionId)
      })
    this.pending.set(opencodeSessionId, next)
  }
}

export const orchestrationTurnObserver = new OrchestrationTurnObserver()
