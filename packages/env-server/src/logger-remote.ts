import { Writable } from 'node:stream'
import { request as undiciRequest } from 'undici'
import { getIdentityToken } from './identity/token.js'
import { config } from './config.js'

/**
 * Pino destination that batches log records in memory and ships them to
 * the identity service's `logs.ingest` mutation. Two design constraints:
 *
 *  - Never block. Identity unreachable / 401 / 5xx must not stall the
 *    process. We buffer with a hard cap and drop oldest on overflow.
 *  - Preserve the source timestamp. Pino emits `time` as ms; we forward
 *    that as-is so `event_ts` reflects when the line happened, not when
 *    we managed to ship it.
 */

interface BufferedEntry {
  ts: number
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  msg: string
  ctx: Record<string, unknown> | null
}

const FLUSH_INTERVAL_MS = 1_000
const FLUSH_AT_SIZE = 200
const MAX_BUFFER = 5_000
const PINO_LEVEL_BY_NUMBER: Record<number, BufferedEntry['level']> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

interface MakeOpts {
  /** Free-form source tag; ends up as `event_logs.source`. */
  source: string
}

export function makeRemoteLogStream(opts: MakeOpts): Writable {
  const buffer: BufferedEntry[] = []
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
    const tok = getIdentityToken()
    if (!tok) return // not paired yet — keep buffering quietly
    flushing = true
    const batch = buffer.splice(0, FLUSH_AT_SIZE * 2)
    try {
      await ship(opts.source, tok, batch)
    } catch {
      // Drop on failure rather than re-queue. Re-queueing on a sustained
      // outage just blows our memory cap; the local stdout stream still
      // has every line.
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
    const ts = typeof rec.time === 'number' ? rec.time : Date.now()
    const msg = typeof rec.msg === 'string' ? rec.msg : ''
    // Strip pino's noisy keys so ctx is the user-supplied bag.
    const { level: _l, time: _t, msg: _m, pid: _p, hostname: _h, ...ctx } = rec
    buffer.push({ ts, level, msg, ctx: Object.keys(ctx).length ? ctx : null })
    if (buffer.length >= MAX_BUFFER) {
      // Drop oldest. Better to lose the start of a flood than the end,
      // since the end usually contains the failure context.
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
      // Pino writes one JSON record per line; chunks may concatenate.
      const text = chunk.toString('utf8')
      for (const line of text.split('\n')) {
        if (line) intake(line)
      }
      cb()
    },
  })

  // Best-effort flush on exit so a crash near startup still shows up.
  const drain = () => {
    void flush()
  }
  process.once('beforeExit', drain)

  return stream
}

async function ship(
  source: string,
  token: string,
  entries: BufferedEntry[],
): Promise<void> {
  const base = config.CC_IDENTITY_URL.replace(/\/+$/, '')
  const url = `${base}/trpc/logs.ingest`
  const body = JSON.stringify({
    json: {
      source,
      entries,
    },
  })
  const res = await undiciRequest(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body,
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
  })
  await res.body.dump()
  if (res.statusCode >= 400) {
    throw new Error(`logs.ingest http ${res.statusCode}`)
  }
}
