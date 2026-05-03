import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('env-server healthz', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns instance id and label', async () => {
    vi.resetModules()
    vi.stubEnv('CC_KIND', 'local')
    vi.stubEnv('CC_WORKING_DIR', '/tmp')
    vi.stubEnv('CC_IDENTITY_URL', 'https://code.438d.xyz')
    vi.stubEnv('CC_STATE_DIR', tempStateDir())
    vi.stubEnv('CC_INSTANCE_ID', 'dev-worktree-a')
    vi.stubEnv('CC_LABEL', 'Worktree A')

    const { runMigrations } = await import('../db/migrate.js')
    const { buildServer } = await import('./server.js')
    await runMigrations()
    const app = await buildServer()

    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        ok: true,
        kind: 'local',
        instanceId: 'dev-worktree-a',
        label: 'Worktree A',
        paired: false,
      })
    } finally {
      await app.close()
    }
  })

  it('desktop-pairs only the matching instance and validates the token', async () => {
    vi.resetModules()
    vi.stubEnv('CC_KIND', 'local')
    vi.stubEnv('CC_WORKING_DIR', '/tmp')
    vi.stubEnv('CC_IDENTITY_URL', 'https://code.438d.xyz')
    vi.stubEnv('CC_STATE_DIR', tempStateDir())
    vi.stubEnv('CC_INSTANCE_ID', 'dev-worktree-a')
    vi.stubEnv('CC_LABEL', 'Worktree A')

    const { runMigrations } = await import('../db/migrate.js')
    const { initEnvMetaFromSecrets } = await import('../envmeta/service.js')
    const { buildServer } = await import('./server.js')
    await runMigrations()
    await initEnvMetaFromSecrets()
    const app = await buildServer()

    try {
      const mismatch = await app.inject({
        method: 'POST',
        url: '/pair/desktop',
        payload: { instanceId: 'other' },
      })
      expect(mismatch.statusCode).toBe(409)

      const paired = await app.inject({
        method: 'POST',
        url: '/pair/desktop',
        payload: { instanceId: 'dev-worktree-a' },
      })
      expect(paired.statusCode).toBe(200)
      const { envToken } = paired.json() as { envToken: string }
      expect(envToken).toBeTruthy()

      const auth = await app.inject({
        method: 'GET',
        url: '/auth/check',
        headers: { authorization: `Bearer ${envToken}` },
      })
      expect(auth.statusCode).toBe(200)
      expect(auth.json()).toEqual({ ok: true, instanceId: 'dev-worktree-a' })
    } finally {
      await app.close()
    }
  })
})

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-env-server-test-'))
}
