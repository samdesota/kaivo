import { EventEmitter } from 'node:events'
import { ulid } from 'ulid'
import { sqliteRaw } from '../db/client.js'
import type { GitDiffResult } from '../git/service.js'
import type { WalkthroughEventType, WalkthroughStatus } from '../db/schema.js'
import type {
  CanonicalDiff,
  ResolvedGitDiffComparison,
  WalkthroughEvent,
  WalkthroughModelSelection,
  WalkthroughSnapshot,
} from './contracts.js'

interface WalkthroughRow {
  id: string
  request_key: string
  status: WalkthroughStatus
  cwd: string
  repository_root: string
  repository_git_dir: string
  repository_head_oid: string | null
  repository_branch: string | null
  comparison_json: string
  base_ref: string | null
  merge_base_oid: string | null
  files_json: string
  patch: string
  patch_digest: string
  patch_byte_count: number
  canonical_json: string
  markdown: string
  covered_units: number
  total_units: number
  warnings_json: string
  error: string | null
  runner_provider_id: string | null
  runner_model_id: string | null
  runner_model_variant: string | null
  runner_session_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  cancelled_at: string | null
  sequence: number
}

interface EventRow {
  id: string
  walkthrough_id: string
  sequence: number
  type: WalkthroughEventType
  data_json: string
  created_at: string
}

export interface CreateQueuedWalkthrough {
  id: string
  requestKey: string
  cwd: string
  comparison: ResolvedGitDiffComparison
  git: GitDiffResult
  canonical: CanonicalDiff
  model: WalkthroughModelSelection
}

type BindValue = string | number | null
type EventDefinition = [WalkthroughEventType, unknown]

const terminalStatuses = new Set<WalkthroughStatus>(['completed', 'failed', 'cancelled'])
const emitter = new EventEmitter()
emitter.setMaxListeners(0)

function now(): string {
  return new Date().toISOString()
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function eventFromRow(row: EventRow): WalkthroughEvent {
  return {
    id: row.id,
    walkthroughId: row.walkthrough_id,
    sequence: row.sequence,
    type: row.type,
    data: parseJson(row.data_json),
    createdAt: row.created_at,
  }
}

function snapshotFromRow(row: WalkthroughRow): WalkthroughSnapshot {
  return {
    id: row.id,
    requestKey: row.request_key,
    status: row.status,
    cwd: row.cwd,
    repository: {
      root: row.repository_root,
      gitDir: row.repository_git_dir,
      headOid: row.repository_head_oid,
      branch: row.repository_branch,
    },
    comparison: parseJson(row.comparison_json),
    baseRef: row.base_ref,
    mergeBaseOid: row.merge_base_oid,
    files: parseJson(row.files_json),
    patch: row.patch,
    patchDigest: row.patch_digest,
    patchByteCount: row.patch_byte_count,
    canonical: parseJson(row.canonical_json),
    markdown: row.markdown,
    coverage: {
      covered: row.covered_units,
      total: row.total_units,
      missing: row.total_units - row.covered_units,
    },
    warnings: parseJson(row.warnings_json),
    error: row.error,
    runner: row.runner_provider_id && row.runner_model_id
      ? {
          providerID: row.runner_provider_id,
          modelID: row.runner_model_id,
          variant: row.runner_model_variant as WalkthroughModelSelection['variant'],
          sessionId: row.runner_session_id,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    sequence: row.sequence,
  }
}

function insertEvents(walkthroughId: string, firstSequence: number, definitions: EventDefinition[], timestamp: string): WalkthroughEvent[] {
  const insert = sqliteRaw.prepare(`
    INSERT INTO walkthrough_events (walkthrough_id, sequence, id, type, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  return definitions.map(([type, data], index) => {
    const event: WalkthroughEvent = {
      id: ulid().toLowerCase(),
      walkthroughId,
      sequence: firstSequence + index,
      type,
      data,
      createdAt: timestamp,
    }
    insert.run(walkthroughId, event.sequence, event.id, type, JSON.stringify(data), timestamp)
    return event
  })
}

export class WalkthroughRepository {
  findIdByRequestKey(requestKey: string): string | null {
    const row = sqliteRaw.prepare('SELECT id FROM walkthroughs WHERE request_key = ?').get(requestKey) as { id: string } | undefined
    return row?.id ?? null
  }

  snapshot(id: string): WalkthroughSnapshot | null {
    const row = sqliteRaw.prepare(`
      SELECT w.*, COALESCE(MAX(e.sequence), 0) AS sequence
      FROM walkthroughs w
      LEFT JOIN walkthrough_events e ON e.walkthrough_id = w.id
      WHERE w.id = ?
      GROUP BY w.id
    `).get(id) as WalkthroughRow | undefined
    return row ? snapshotFromRow(row) : null
  }

  createQueued(input: CreateQueuedWalkthrough): { snapshot: WalkthroughSnapshot; created: boolean; events: WalkthroughEvent[] } {
    const transaction = sqliteRaw.transaction(() => {
      const existingId = this.findIdByRequestKey(input.requestKey)
      if (existingId) return { id: existingId, created: false, events: [] as WalkthroughEvent[] }
      const timestamp = now()
      sqliteRaw.prepare(`
        INSERT INTO walkthroughs (
          id, request_key, status, cwd, repository_root, repository_git_dir,
          repository_head_oid, repository_branch, comparison_json, base_ref,
          merge_base_oid, files_json, patch, patch_digest, patch_byte_count,
          canonical_json, markdown, covered_units, total_units, warnings_json,
          runner_provider_id, runner_model_id, runner_model_variant,
          created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.requestKey,
        input.cwd,
        input.git.repository.root,
        input.git.repository.gitDir,
        input.git.repository.headOid,
        input.git.repository.branch,
        JSON.stringify(input.comparison),
        input.git.baseRef,
        input.git.mergeBaseOid,
        JSON.stringify(input.git.files),
        input.git.patch,
        input.canonical.digest,
        input.canonical.byteCount,
        JSON.stringify(input.canonical),
        input.canonical.unitIds.length,
        JSON.stringify(input.git.warnings),
        input.model.providerID,
        input.model.modelID,
        input.model.variant,
        timestamp,
        timestamp,
      )
      const definitions: EventDefinition[] = [
        ['started', { walkthroughId: input.id, patchDigest: input.canonical.digest }],
        ...input.git.warnings.map((warning): EventDefinition => ['warning', { warning }]),
      ]
      return { id: input.id, created: true, events: insertEvents(input.id, 1, definitions, timestamp) }
    })

    let result: ReturnType<typeof transaction>
    try {
      result = transaction()
    } catch (error) {
      if (!(error instanceof Error) || !/UNIQUE constraint failed: walkthroughs\.request_key/.test(error.message)) throw error
      const id = this.findIdByRequestKey(input.requestKey)
      if (!id) throw error
      result = { id, created: false, events: [] }
    }
    const snapshot = this.snapshot(result.id)
    if (!snapshot) throw new Error('walkthrough transaction did not produce a snapshot')
    this.publish(result.events)
    return { snapshot, created: result.created, events: result.events }
  }

  private update(id: string, change: (current: WalkthroughSnapshot, timestamp: string) => {
    sql: string
    params: BindValue[]
    events: EventDefinition[]
  } | null): { snapshot: WalkthroughSnapshot; events: WalkthroughEvent[] } | null {
    const transaction = sqliteRaw.transaction(() => {
      const current = this.snapshot(id)
      if (!current) return null
      const timestamp = now()
      const next = change(current, timestamp)
      if (!next) return { snapshot: current, events: [] as WalkthroughEvent[] }
      sqliteRaw.prepare(next.sql).run(...next.params, timestamp, id)
      const events = insertEvents(id, current.sequence + 1, next.events, timestamp)
      const snapshot = this.snapshot(id)
      if (!snapshot) throw new Error('walkthrough update lost its snapshot')
      return { snapshot, events }
    })
    const result = transaction()
    if (result) this.publish(result.events)
    return result
  }

  transition(id: string, status: WalkthroughStatus): WalkthroughSnapshot | null {
    const result = this.update(id, (current) => {
      if (terminalStatuses.has(current.status) || current.status === status) return null
      return {
        sql: 'UPDATE walkthroughs SET status = ?, updated_at = ? WHERE id = ?',
        params: [status],
        events: [['status.changed', { status }]],
      }
    })
    return result?.snapshot ?? null
  }

  setRunnerSession(id: string, sessionId: string): WalkthroughSnapshot | null {
    const result = this.update(id, (current) => {
      if (terminalStatuses.has(current.status) || current.runner?.sessionId === sessionId) return null
      return {
        sql: 'UPDATE walkthroughs SET runner_session_id = ?, updated_at = ? WHERE id = ?',
        params: [sessionId],
        events: [],
      }
    })
    return result?.snapshot ?? null
  }

  appendMarkdown(id: string, markdown: string, covered?: number): WalkthroughSnapshot | null {
    if (!markdown) return this.snapshot(id)
    const result = this.update(id, (current) => {
      if (terminalStatuses.has(current.status)) return null
      const bounded = covered === undefined
        ? current.coverage.covered
        : Math.max(0, Math.min(covered, current.coverage.total))
      const coverage = { covered: bounded, total: current.coverage.total, missing: current.coverage.total - bounded }
      return {
        sql: 'UPDATE walkthroughs SET markdown = markdown || ?, covered_units = ?, updated_at = ? WHERE id = ?',
        params: [markdown, bounded],
        events: [
          ['markdown.appended', { markdown }],
          ...(bounded === current.coverage.covered ? [] : [['coverage.changed', coverage] as EventDefinition]),
        ],
      }
    })
    return result?.snapshot ?? null
  }

  setCoverage(id: string, covered: number): WalkthroughSnapshot | null {
    const result = this.update(id, (current) => {
      if (terminalStatuses.has(current.status)) return null
      const bounded = Math.max(0, Math.min(covered, current.coverage.total))
      return {
        sql: 'UPDATE walkthroughs SET covered_units = ?, updated_at = ? WHERE id = ?',
        params: [bounded],
        events: [['coverage.changed', { covered: bounded, total: current.coverage.total, missing: current.coverage.total - bounded }]],
      }
    })
    return result?.snapshot ?? null
  }

  complete(id: string, covered: number): WalkthroughSnapshot | null {
    const result = this.update(id, (current, timestamp) => {
      if (terminalStatuses.has(current.status)) return null
      if (covered !== current.coverage.total) throw new Error('completed walkthrough must cover every canonical unit')
      const coverage = { covered, total: current.coverage.total, missing: 0 }
      const coverageEvents: EventDefinition[] = current.coverage.covered === covered
        ? []
        : [['coverage.changed', coverage]]
      return {
        sql: 'UPDATE walkthroughs SET status = \'completed\', covered_units = ?, completed_at = ?, updated_at = ? WHERE id = ?',
        params: [covered, timestamp],
        events: [
          ...coverageEvents,
          ['status.changed', { status: 'completed' }],
          ['completed', { coverage }],
        ],
      }
    })
    return result?.snapshot ?? null
  }

  fail(id: string, error: string): WalkthroughSnapshot | null {
    const result = this.update(id, (current) => {
      if (terminalStatuses.has(current.status)) return null
      return {
        sql: 'UPDATE walkthroughs SET status = \'failed\', error = ?, updated_at = ? WHERE id = ?',
        params: [error],
        events: [['status.changed', { status: 'failed' }], ['failed', { error }]],
      }
    })
    return result?.snapshot ?? null
  }

  cancel(id: string): { snapshot: WalkthroughSnapshot; events: WalkthroughEvent[] } | null {
    return this.update(id, (current, timestamp) => {
      if (terminalStatuses.has(current.status)) return null
      return {
        sql: 'UPDATE walkthroughs SET status = \'cancelled\', cancelled_at = ?, updated_at = ? WHERE id = ?',
        params: [timestamp],
        events: [['status.changed', { status: 'cancelled' }], ['cancelled', {}]],
      }
    })
  }

  events(id: string, afterSequence: number): WalkthroughEvent[] {
    return (sqliteRaw.prepare(`
      SELECT id, walkthrough_id, sequence, type, data_json, created_at
      FROM walkthrough_events WHERE walkthrough_id = ? AND sequence > ? ORDER BY sequence
    `).all(id, afterSequence) as EventRow[]).map(eventFromRow)
  }

  subscribe(id: string, listener: (event: WalkthroughEvent) => void): () => void {
    emitter.on(id, listener)
    return () => emitter.off(id, listener)
  }

  private publish(events: WalkthroughEvent[]): void {
    for (const event of events) emitter.emit(event.walkthroughId, event)
  }
}

export const walkthroughRepository = new WalkthroughRepository()
