import { afterEach, describe, expect, it, vi } from 'vitest'

describe('session cookie isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('uses different cookie names for different local app instances', async () => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('CC_INSTANCE_ID', 'normal-app')
    const normal = await import('./cookie.js')

    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('CC_INSTANCE_ID', 'worktree-app')
    const worktree = await import('./cookie.js')

    expect(normal.SESSION_COOKIE).not.toBe(worktree.SESSION_COOKIE)
    expect(normal.SESSION_COOKIE).toBe('ccenv_sid_normal-app')
    expect(worktree.SESSION_COOKIE).toBe('ccenv_sid_worktree-app')
  })

  it('keeps the base cookie name when an explicit cookie domain is configured', async () => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CC_INSTANCE_ID', 'production-app')
    vi.stubEnv('COOKIE_DOMAIN', '438d.xyz')

    const cookie = await import('./cookie.js')

    expect(cookie.SESSION_COOKIE).toBe('ccenv_sid')
  })
})
