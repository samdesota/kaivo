import { lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { eventLogs, type LogLevel } from '../db/schema.js'

const VALID_LEVELS: ReadonlySet<LogLevel> = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
])

export interface IngestEntry {
  /** Captured at the source. */
  ts: Date
  level: LogLevel
  msg: string
  ctx?: Record<string, unknown> | null
}

export interface IngestRequest {
  source: string
  principal: string | null
  entries: IngestEntry[]
}

export const RETENTION_DAYS = 30
export const MAX_BATCH_SIZE = 500
export const MAX_MSG_BYTES = 16 * 1024
export const MAX_CTX_BYTES = 32 * 1024

// Per-(source,principal) rate limit. Plenty of headroom for normal pino
// chatter while still putting a lid on a runaway loop.
const RATE_WINDOW_MS = 60_000
const RATE_MAX_PER_WINDOW = 5_000

interface RateBucket {
  windowStart: number
  count: number
  dropped: number
}

const buckets = new Map<string, RateBucket>()

function rateKey(source: string, principal: string | null): string {
  return `${source}::${principal ?? ''}`
}

/**
 * Returns how many of `n` requested inserts fit within the bucket. The
 * caller is expected to drop the overflow and surface the count via the
 * response so noisy clients can back off.
 */
function reserveBudget(source: string, principal: string | null, n: number): number {
  const now = Date.now()
  const key = rateKey(source, principal)
  let b = buckets.get(key)
  if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
    b = { windowStart: now, count: 0, dropped: 0 }
    buckets.set(key, b)
  }
  const remaining = Math.max(0, RATE_MAX_PER_WINDOW - b.count)
  const allowed = Math.min(remaining, n)
  b.count += allowed
  b.dropped += n - allowed
  return allowed
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

function clampCtx(
  ctx: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!ctx) return null
  try {
    const json = JSON.stringify(ctx)
    if (json.length <= MAX_CTX_BYTES) return ctx
    return { _truncated: true, preview: json.slice(0, MAX_CTX_BYTES) }
  } catch {
    return { _unserializable: true }
  }
}

export interface IngestResult {
  accepted: number
  dropped: number
}

export async function ingestLogs(req: IngestRequest): Promise<IngestResult> {
  if (req.entries.length === 0) return { accepted: 0, dropped: 0 }
  const trimmed = req.entries.slice(0, MAX_BATCH_SIZE)
  const allowed = reserveBudget(req.source, req.principal, trimmed.length)
  if (allowed === 0) return { accepted: 0, dropped: req.entries.length }
  const accepted = trimmed.slice(0, allowed)
  const rows = accepted
    .filter((e) => VALID_LEVELS.has(e.level) && typeof e.msg === 'string')
    .map((e) => ({
      eventTs: e.ts,
      source: req.source,
      principal: req.principal,
      level: e.level,
      msg: clamp(e.msg, MAX_MSG_BYTES),
      ctx: clampCtx(e.ctx),
    }))
  if (rows.length === 0) {
    return { accepted: 0, dropped: req.entries.length }
  }
  await db.insert(eventLogs).values(rows)
  return { accepted: rows.length, dropped: req.entries.length - rows.length }
}

export async function purgeExpiredLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const result = await db.delete(eventLogs).where(lt(eventLogs.eventTs, cutoff))
  return result.rowCount ?? 0
}
