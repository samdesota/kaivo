import { Writable } from 'node:stream'
import { ingestLogs, type IngestEntry } from './service.js'
import type { LogLevel } from '../db/schema.js'

/**
 * Pino destination for the orchestrator process. Writes straight to the
 * local Postgres `event_logs` table instead of HTTP-looping through its
 * own ingest endpoint. Same buffer / drop / never-block semantics as the
 * env-server's remote stream.
 */

const FLUSH_INTERVAL_MS = 1_000
const FLUSH_AT_SIZE = 200
const MAX_BUFFER = 5_000

const PINO_LEVEL_BY_NUMBER: Record<number, LogLevel> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

interface MakeOpts {
  source: string
  principal?: string | null
}

export function makeLocalLogStream(opts: MakeOpts): Writable {
  const buffer: IngestEntry[] = []
  let timer: NodeJS.Timeout | null = null
  let flushing = false

  function scheduleFlush() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, FLUSH_INTERVAL_MS)
    timer.unref()
  }

  async function flush() {
    if (flushing || buffer.length === 0) return
    flushing = true
    const batch = buffer.splice(0, FLUSH_AT_SIZE * 2)
    try {
      await ingestLogs({
        source: opts.source,
        principal: opts.principal ?? null,
        entries: batch,
      })
    } catch {
      // Don't requeue: the line is still in stdout, and a sustained DB
      // outage shouldn't blow the in-process buffer.
    } finally {
      flushing = false
      if (buffer.length > 0) scheduleFlush()
    }
  }

  function intake(line: string) {
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const levelNum = typeof rec.level === 'number' ? rec.level : 30
    const level = PINO_LEVEL_BY_NUMBER[levelNum] ?? 'info'
    const ts = typeof rec.time === 'number' ? new Date(rec.time) : new Date()
    const msg = typeof rec.msg === 'string' ? rec.msg : ''
    const { level: _l, time: _t, msg: _m, pid: _p, hostname: _h, ...ctx } = rec
    buffer.push({ ts, level, msg, ctx: Object.keys(ctx).length ? ctx : null })
    if (buffer.length >= MAX_BUFFER) {
      buffer.splice(0, buffer.length - MAX_BUFFER + 1)
    }
    if (buffer.length >= FLUSH_AT_SIZE) {
      void flush()
    } else {
      scheduleFlush()
    }
  }

  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString('utf8')
      for (const line of text.split('\n')) {
        if (line) intake(line)
      }
      cb()
    },
  })

  process.once('beforeExit', () => {
    void flush()
  })

  return stream
}
