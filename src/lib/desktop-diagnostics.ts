import { clientLogger } from './client-logger'

type DesktopDiagnostics = {
  diagnosticsPing?: (input: { seq: number; rendererNow: number }) => Promise<unknown>
}

const PING_INTERVAL_MS = 2_000
const WARN_AFTER_MS = 750
const HUNG_AFTER_MS = 5_000

let installed = false

export function installDesktopDiagnostics(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const desktop = (window as Window & { cloudCodeDesktop?: DesktopDiagnostics }).cloudCodeDesktop
  if (!desktop?.diagnosticsPing) return

  let seq = 0
  let expected = performance.now() + PING_INTERVAL_MS
  let pending: { seq: number; startedAt: number; reportedHung: boolean } | null = null

  setInterval(() => {
    const now = performance.now()
    const rendererLagMs = now - expected
    expected = now + PING_INTERVAL_MS
    if (rendererLagMs > WARN_AFTER_MS) {
      logDiagnostic('renderer event loop lag detected', { rendererLagMs: Math.round(rendererLagMs) })
    }

    if (pending) {
      const pendingMs = now - pending.startedAt
      if (!pending.reportedHung && pendingMs > HUNG_AFTER_MS) {
        pending.reportedHung = true
        logDiagnostic('main diagnostics ping pending', { seq: pending.seq, pendingMs: Math.round(pendingMs) })
      }
      return
    }

    const pingSeq = ++seq
    const startedAt = performance.now()
    pending = { seq: pingSeq, startedAt, reportedHung: false }
    void desktop.diagnosticsPing!({ seq: pingSeq, rendererNow: Date.now() }).then(
      (response) => {
        const latencyMs = performance.now() - startedAt
        const wasHung = pending?.seq === pingSeq && pending.reportedHung
        pending = pending?.seq === pingSeq ? null : pending
        if (latencyMs > WARN_AFTER_MS || wasHung) {
          logDiagnostic(wasHung ? 'main diagnostics ping recovered' : 'main diagnostics ping slow', {
            seq: pingSeq,
            latencyMs: Math.round(latencyMs),
            response,
          })
        }
      },
      (error) => {
        pending = pending?.seq === pingSeq ? null : pending
        logDiagnostic('main diagnostics ping failed', {
          seq: pingSeq,
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }, PING_INTERVAL_MS)
}

function logDiagnostic(message: string, ctx: Record<string, unknown>) {
  const payload = { ...ctx, url: window.location.href }
  console.warn(`[desktop-diagnostics] ${message} ${JSON.stringify(payload)}`)
  clientLogger.warn(`[desktop-diagnostics] ${message}`, payload)
}
