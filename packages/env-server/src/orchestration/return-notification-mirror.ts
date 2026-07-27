import { sqliteRaw } from '../db/client.js'
import { createAgentNotification } from '../identity/client.js'
import { logger } from '../logger.js'

type PendingNotification = {
  returnId: string
  workspaceId: string
  sessionId: string
  title: string | null
  kind: 'response' | 'error'
  summary: string
}

export type ReturnNotificationSender = (input: {
  idempotencyKey: string
  workspaceId: string
  sessionId: string
  kind: 'finished' | 'error'
  title: string
  summary: string
}) => Promise<unknown>

export class ReturnNotificationMirror {
  constructor(private readonly send: ReturnNotificationSender = createAgentNotification) {}

  async drain(): Promise<void> {
    const rows = sqliteRaw.prepare(`
      SELECT outbox.return_id AS returnId, outbox.workspace_id AS workspaceId,
        sessions.id AS sessionId, sessions.title AS title,
        returns.kind AS kind, returns.summary AS summary
      FROM orchestration_return_notification_outbox outbox
      JOIN orchestration_returns returns ON returns.id = outbox.return_id
      JOIN orchestration_subtasks subtasks ON subtasks.id = outbox.subtask_id
      JOIN agent_sessions sessions ON sessions.id = subtasks.session_id
      WHERE outbox.delivered_at IS NULL
      ORDER BY outbox.created_at, outbox.return_id
      LIMIT 100
    `).all() as PendingNotification[]
    for (const row of rows) await this.deliver(row)
  }

  private async deliver(row: PendingNotification): Promise<void> {
    try {
      await this.send({
        idempotencyKey: `orchestration-return:${row.returnId}`,
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        kind: row.kind === 'error' ? 'error' : 'finished',
        title: row.title?.trim() || (row.kind === 'error' ? 'Task needs attention' : 'Task returned'),
        summary: row.summary.slice(0, 120),
      })
      const timestamp = new Date().toISOString()
      sqliteRaw.prepare(`UPDATE orchestration_return_notification_outbox
        SET delivered_at = ?, updated_at = ?, attempts = attempts + 1, last_error = NULL
        WHERE return_id = ?`).run(timestamp, timestamp, row.returnId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sqliteRaw.prepare(`UPDATE orchestration_return_notification_outbox
        SET updated_at = ?, attempts = attempts + 1, last_error = ?
        WHERE return_id = ?`).run(new Date().toISOString(), message.slice(0, 1_000), row.returnId)
      logger.warn({ err, returnId: row.returnId }, 'failed to mirror orchestration return notification')
    }
  }
}

export const returnNotificationMirror = new ReturnNotificationMirror()
