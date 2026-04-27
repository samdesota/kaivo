import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('local app SQLite boot', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds the app server with SQLite app storage', async () => {
    vi.resetModules()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-local-app-test-'))
    const sqlitePath = path.join(dataDir, 'app.db')
    vi.stubEnv('APP_SQLITE_PATH', sqlitePath)
    vi.stubEnv('DATA_DIR', dataDir)
    vi.stubEnv('CC_SERVICE_CREDENTIAL', 'test-service-credential-min-16-chars')

    const { runLocalAppMigrations } = await import('./db/local-migrate.js')
    const { buildServer } = await import('./index.js')
    runLocalAppMigrations(sqlitePath)
    const app = await buildServer()

    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ ok: true, instanceId: 'default' })
      expect(fs.existsSync(sqlitePath)).toBe(true)
    } finally {
      await app.close()
    }
  })
})
