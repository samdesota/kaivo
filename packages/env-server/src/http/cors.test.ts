import { describe, expect, it, vi } from 'vitest'

describe('local env CORS origins', () => {
  it('allows configured production origin and loopback dev origins for local envs', async () => {
    vi.resetModules()
    vi.stubEnv('CC_KIND', 'local')
    vi.stubEnv('CC_WORKING_DIR', '/tmp')
    vi.stubEnv('CC_IDENTITY_URL', 'https://code.438d.xyz')
    vi.stubEnv('CC_STATE_DIR', '/tmp/cc-env-state')
    vi.stubEnv('CC_ALLOWED_ORIGINS', 'https://code.438d.xyz')

    const { isAllowedOrigin } = await import('./cors.js')

    expect(isAllowedOrigin('https://code.438d.xyz')).toBe(true)
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true)
    expect(isAllowedOrigin('http://evil.test:3000')).toBe(false)
  })
})
