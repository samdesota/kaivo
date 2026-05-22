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
const ENABLED_NAMESPACES_KEY = 'kaivo.logs.enabled'
const CONSOLE_ENABLED_KEY = 'kaivo.logs.console'

const buffer: Entry[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false

type LoggerApi = {
  trace(msg: string, ctx?: Record<string, unknown>): void
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
  fatal(msg: string, ctx?: Record<string, unknown>): void
}

type ClientLogControls = {
  enable(namespaces?: string | string[]): void
  disable(namespaces?: string | string[]): void
  console(enabled?: boolean): void
  status(): { enabled: string[]; console: boolean }
}

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

function record(level: Level, msg: string, ctx?: Record<string, unknown>, options: { console?: boolean } = {}) {
  const entry = { ts: Date.now(), level, msg, ctx: ctx ?? null }
  push(entry)
  if (options.console || isConsoleEnabled()) writeConsole(entry)
}

function createLogger(namespace?: string, options: { gated?: boolean } = {}): LoggerApi {
  const prefix = namespace ? `[${namespace}] ` : ''
  const scopedCtx = (ctx?: Record<string, unknown>) => namespace ? { namespace, ...(ctx ?? {}) } : ctx
  const shouldRecord = () => !options.gated || !namespace || isNamespaceEnabled(namespace)
  return {
    trace: (msg, ctx) => { if (shouldRecord()) record('trace', `${prefix}${msg}`, scopedCtx(ctx)) },
    debug: (msg, ctx) => { if (shouldRecord()) record('debug', `${prefix}${msg}`, scopedCtx(ctx)) },
    info: (msg, ctx) => { if (shouldRecord()) record('info', `${prefix}${msg}`, scopedCtx(ctx)) },
    warn: (msg, ctx) => record('warn', `${prefix}${msg}`, scopedCtx(ctx), { console: true }),
    error: (msg, ctx) => record('error', `${prefix}${msg}`, scopedCtx(ctx), { console: true }),
    fatal: (msg, ctx) => record('fatal', `${prefix}${msg}`, scopedCtx(ctx), { console: true }),
  }
}

export const clientLogger = {
  trace: (msg: string, ctx?: Record<string, unknown>) => record('trace', msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => record('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => record('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => record('warn', msg, ctx, { console: true }),
  error: (msg: string, ctx?: Record<string, unknown>) => record('error', msg, ctx, { console: true }),
  fatal: (msg: string, ctx?: Record<string, unknown>) => record('fatal', msg, ctx, { console: true }),
  diagnostic: (namespace: string) => createLogger(namespace, { gated: true }),
  isEnabled: isNamespaceEnabled,
  /** Force-flush — useful before a navigation that will tear down the page. */
  flush,
}

export type ClientLogger = typeof clientLogger

let installed = false
export function installClientLogCapture(): void {
  if (installed) return
  installed = true
  installClientLogControls()

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

function installClientLogControls(): void {
  const target = window as unknown as { kaivoLogs?: ClientLogControls }
  target.kaivoLogs = {
    enable(namespaces = '*') {
      const enabled = new Set(readEnabledNamespaces())
      for (const namespace of normalizeNamespaces(namespaces)) enabled.add(namespace)
      writeEnabledNamespaces([...enabled])
      console.info('[kaivo-logs] enabled', [...enabled])
    },
    disable(namespaces) {
      if (!namespaces) {
        writeEnabledNamespaces([])
        console.info('[kaivo-logs] disabled all namespaces')
        return
      }
      const disabled = new Set(normalizeNamespaces(namespaces))
      writeEnabledNamespaces(readEnabledNamespaces().filter((namespace) => !disabled.has(namespace)))
      console.info('[kaivo-logs] enabled', readEnabledNamespaces())
    },
    console(enabled = true) {
      safeLocalStorageSet(CONSOLE_ENABLED_KEY, enabled ? '1' : '0')
      console.info('[kaivo-logs] console', enabled)
    },
    status() {
      return { enabled: readEnabledNamespaces(), console: isConsoleEnabled() }
    },
  }
}

function isNamespaceEnabled(namespace: string): boolean {
  const enabled = readEnabledNamespaces()
  return enabled.includes('*') || enabled.includes(namespace)
}

function readEnabledNamespaces(): string[] {
  const raw = safeLocalStorageGet(ENABLED_NAMESPACES_KEY) ?? ''
  return normalizeNamespaces(raw)
}

function writeEnabledNamespaces(namespaces: string[]): void {
  safeLocalStorageSet(ENABLED_NAMESPACES_KEY, normalizeNamespaces(namespaces).join(','))
}

function isConsoleEnabled(): boolean {
  return safeLocalStorageGet(CONSOLE_ENABLED_KEY) === '1'
}

function normalizeNamespaces(input: string | string[]): string[] {
  const values = Array.isArray(input) ? input : input.split(',')
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function writeConsole(entry: Entry): void {
  const args = entry.ctx ? [entry.msg, entry.ctx] : [entry.msg]
  if (entry.level === 'warn') console.warn(...args)
  else if (entry.level === 'error' || entry.level === 'fatal') console.error(...args)
  else if (entry.level === 'debug' || entry.level === 'trace') console.debug(...args)
  else console.info(...args)
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore localStorage failures in private/locked-down contexts
  }
}
