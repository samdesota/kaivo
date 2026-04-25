/**
 * Browser-side log shipper. Captures explicit `clientLogger.*` calls plus
 * uncaught errors / unhandled rejections, and batches them up to the
 * orchestrator's `logs.ingestBrowser` endpoint. Auth = the existing web
 * session cookie (server forces source = "browser" so a logged-in user
 * can't pose as an internal service).
 *
 * No tRPC React dependency — this runs at module-load time so it has to
 * post via plain fetch. We hand-roll the tRPC wire shape (superjson) the
 * same way env-server's identity client does for the orchestrator side.
 */

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

interface Entry {
  ts: number
  level: Level
  msg: string
  ctx?: Record<string, unknown> | null
}

const FLUSH_INTERVAL_MS = 1_000
const FLUSH_AT_SIZE = 50
const MAX_BUFFER = 500

const buffer: Entry[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false

function scheduleFlush() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flush()
  }, FLUSH_INTERVAL_MS)
}

async function flush() {
  if (inFlight || buffer.length === 0) return
  inFlight = true
  const batch = buffer.splice(0, FLUSH_AT_SIZE * 2)
  try {
    const res = await fetch('/trpc/logs.ingestBrowser', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { entries: batch } }),
      // Browsers retry on visibilitychange via sendBeacon; here we just
      // accept that a flushing tab kept open for a long time eventually
      // succeeds. No reason to keepalive every batch.
    })
    if (!res.ok) {
      // Drop on rejection; same rationale as the Node transports.
    }
  } catch {
    // Network down — drop the batch, keep accepting new entries.
  } finally {
    inFlight = false
    if (buffer.length > 0) scheduleFlush()
  }
}

function push(entry: Entry) {
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) {
    buffer.splice(0, buffer.length - MAX_BUFFER)
  }
  if (buffer.length >= FLUSH_AT_SIZE) {
    void flush()
  } else {
    scheduleFlush()
  }
}

function record(level: Level, msg: string, ctx?: Record<string, unknown>) {
  push({ ts: Date.now(), level, msg, ctx: ctx ?? null })
}

export const clientLogger = {
  trace: (msg: string, ctx?: Record<string, unknown>) => record('trace', msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => record('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => record('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => record('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => record('error', msg, ctx),
  fatal: (msg: string, ctx?: Record<string, unknown>) => record('fatal', msg, ctx),
  /** Force-flush — useful before a navigation that will tear down the page. */
  flush,
}

let installed = false
export function installClientLogCapture(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (event) => {
    const err = event.error
    record('error', event.message || 'window.onerror', {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: err && typeof err === 'object' && 'stack' in err ? String((err as Error).stack) : undefined,
      url: window.location.href,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const msg =
      reason && typeof reason === 'object' && 'message' in reason
        ? String((reason as Error).message)
        : String(reason)
    record('error', `unhandled rejection: ${msg}`, {
      stack:
        reason && typeof reason === 'object' && 'stack' in reason
          ? String((reason as Error).stack)
          : undefined,
      url: window.location.href,
    })
  })

  // Best-effort flush when the tab is hidden/closed. sendBeacon is the
  // right tool here because regular fetch may be aborted on unload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && buffer.length > 0) {
      try {
        const batch = buffer.splice(0, buffer.length)
        const blob = new Blob(
          [JSON.stringify({ json: { entries: batch } })],
          { type: 'application/json' },
        )
        navigator.sendBeacon('/trpc/logs.ingestBrowser', blob)
      } catch {
        // ignore
      }
    }
  })
}
