const WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const LOCK_THRESHOLD = 10
// First few failures are "fat-finger grace" — no backoff, just reject.
// After that, exponential: 2^4=16s, 2^5=32s, 2^6=64s, ...
const GRACE_FAILURES = 2
const BACKOFF_BASE_POW = 4
const MAX_BACKOFF_SEC = 600

interface Entry {
  failures: number[] // timestamps within WINDOW_MS
  nextAllowedAt: number
}

const state = new Map<string, Entry>()

function prune(e: Entry, now: number): void {
  const cutoff = now - WINDOW_MS
  e.failures = e.failures.filter((t) => t > cutoff)
}

export interface ThrottleCheck {
  allowed: boolean
  retryAfterSec?: number
  reason?: 'locked' | 'backoff'
}

export function checkThrottle(ip: string, now = Date.now()): ThrottleCheck {
  const entry = state.get(ip)
  if (!entry) return { allowed: true }
  prune(entry, now)

  if (entry.failures.length >= LOCK_THRESHOLD) {
    const oldest = entry.failures[0]!
    const unlockAt = oldest + WINDOW_MS
    return {
      allowed: false,
      reason: 'locked',
      retryAfterSec: Math.max(1, Math.ceil((unlockAt - now) / 1000)),
    }
  }

  if (now < entry.nextAllowedAt) {
    return {
      allowed: false,
      reason: 'backoff',
      retryAfterSec: Math.max(1, Math.ceil((entry.nextAllowedAt - now) / 1000)),
    }
  }

  return { allowed: true }
}

export function recordFailure(ip: string, now = Date.now()): void {
  const entry = state.get(ip) ?? { failures: [], nextAllowedAt: 0 }
  prune(entry, now)
  entry.failures.push(now)

  if (entry.failures.length <= GRACE_FAILURES) {
    entry.nextAllowedAt = 0
  } else {
    const step = entry.failures.length - GRACE_FAILURES - 1
    const exp = Math.min(BACKOFF_BASE_POW + step, 16)
    const delaySec = Math.min(2 ** exp, MAX_BACKOFF_SEC)
    entry.nextAllowedAt = now + delaySec * 1000
  }

  state.set(ip, entry)
}

export function recordSuccess(ip: string): void {
  state.delete(ip)
}

export function __resetThrottleForTests(): void {
  state.clear()
}
