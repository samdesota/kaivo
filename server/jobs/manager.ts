import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client.js'
import { jobs, type JobState } from '../db/schema.js'
import { logger } from '../logger.js'

/**
 * In-memory tracking for long-running jobs (clone, etc.) with DB-backed
 * persistence so UI reconnects see history. Log lines are buffered
 * in-memory; older lines fall off once the cap is hit.
 */

export interface JobLogEntry {
  seq: number
  ts: Date
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface Job {
  id: string
  kind: string
  sandboxId: string | null
  state: JobState
  progressPct: number
  message: string | null
  error: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
  logs: JobLogEntry[]
}

export type JobUpdate =
  | { type: 'state'; job: Job }
  | { type: 'log'; jobId: string; entry: JobLogEntry }

const LOG_CAP = 500

type Listener = (update: JobUpdate) => void

class JobManager {
  private jobs = new Map<string, Job>()
  private listeners = new Map<string, Set<Listener>>()
  private seq = new Map<string, number>()

  async create(opts: {
    kind: string
    sandboxId: string | null
    message?: string
    metadata?: Record<string, unknown>
  }): Promise<Job> {
    const id = ulid().toLowerCase()
    const now = new Date()
    const job: Job = {
      id,
      kind: opts.kind,
      sandboxId: opts.sandboxId,
      state: 'pending',
      progressPct: 0,
      message: opts.message ?? null,
      error: null,
      metadata: opts.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      logs: [],
    }
    this.jobs.set(id, job)
    this.seq.set(id, 0)
    await db.insert(jobs).values({
      id,
      kind: opts.kind,
      sandboxId: opts.sandboxId,
      state: 'pending',
      progressPct: 0,
      message: opts.message ?? null,
      metadataJson: opts.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    return job
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null
  }

  async getOrLoad(id: string): Promise<Job | null> {
    const existing = this.jobs.get(id)
    if (existing) return existing
    const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1)
    const row = rows[0]
    if (!row) return null
    const j: Job = {
      id: row.id,
      kind: row.kind,
      sandboxId: row.sandboxId ?? null,
      state: row.state,
      progressPct: row.progressPct,
      message: row.message ?? null,
      error: row.error ?? null,
      metadata: (row.metadataJson ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finishedAt: row.finishedAt ?? null,
      logs: [],
    }
    this.jobs.set(id, j)
    this.seq.set(id, 0)
    return j
  }

  async listBySandbox(sandboxId: string): Promise<Job[]> {
    const out: Job[] = []
    for (const j of this.jobs.values()) {
      if (j.sandboxId === sandboxId) out.push(j)
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return out
  }

  log(id: string, level: JobLogEntry['level'], message: string): void {
    const j = this.jobs.get(id)
    if (!j) return
    const seq = (this.seq.get(id) ?? 0) + 1
    this.seq.set(id, seq)
    const entry: JobLogEntry = { seq, ts: new Date(), level, message }
    j.logs.push(entry)
    if (j.logs.length > LOG_CAP) j.logs.splice(0, j.logs.length - LOG_CAP)
    j.updatedAt = entry.ts
    this.emit(id, { type: 'log', jobId: id, entry })
  }

  async update(
    id: string,
    patch: {
      state?: JobState
      progressPct?: number
      message?: string | null
      error?: string | null
    },
  ): Promise<void> {
    const j = this.jobs.get(id)
    if (!j) return
    if (patch.state !== undefined) j.state = patch.state
    if (patch.progressPct !== undefined) j.progressPct = patch.progressPct
    if (patch.message !== undefined) j.message = patch.message
    if (patch.error !== undefined) j.error = patch.error
    j.updatedAt = new Date()
    if (patch.state === 'succeeded' || patch.state === 'failed' || patch.state === 'cancelled') {
      j.finishedAt = j.updatedAt
    }
    try {
      await db
        .update(jobs)
        .set({
          state: j.state,
          progressPct: j.progressPct,
          message: j.message,
          error: j.error,
          updatedAt: j.updatedAt,
          finishedAt: j.finishedAt,
        })
        .where(eq(jobs.id, id))
    } catch (err) {
      logger.warn({ err, id }, 'job DB update failed')
    }
    this.emit(id, { type: 'state', job: j })
  }

  subscribe(id: string, fn: Listener): () => void {
    let set = this.listeners.get(id)
    if (!set) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(fn)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) this.listeners.delete(id)
    }
  }

  private emit(id: string, update: JobUpdate): void {
    const set = this.listeners.get(id)
    if (!set) return
    for (const l of set) {
      try {
        l(update)
      } catch (err) {
        logger.warn({ err, id }, 'job listener threw')
      }
    }
  }
}

export const jobManager = new JobManager()
