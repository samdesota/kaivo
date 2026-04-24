/**
 * Per-env bearer tokens. Kept in localStorage keyed by envId so the
 * webapp can talk to each env directly (the orchestrator never sees
 * these). Survives page reloads; cleared on sign-out via
 * `clearAllEnvTokens()`.
 */

const STORAGE_KEY = 'cc.envTokens'

export function getEnvTokens(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
    return {}
  } catch {
    return {}
  }
}

export function getEnvToken(envId: string): string | null {
  return getEnvTokens()[envId] ?? null
}

export function setEnvToken(envId: string, token: string): void {
  const all = getEnvTokens()
  all[envId] = token
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function clearEnvToken(envId: string): void {
  const all = getEnvTokens()
  if (!(envId in all)) return
  delete all[envId]
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function clearAllEnvTokens(): void {
  window.localStorage.removeItem(STORAGE_KEY)
}
