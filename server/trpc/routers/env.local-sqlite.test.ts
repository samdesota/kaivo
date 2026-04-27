import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('env router local SQLite listing', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('lists the instance-paired local env without fixed-port discovery input', async () => {
    vi.resetModules()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-env-router-test-'))
    const sqlitePath = path.join(dataDir, 'app.db')
    vi.stubEnv('APP_SQLITE_PATH', sqlitePath)
    vi.stubEnv('DATA_DIR', dataDir)
    vi.stubEnv('CC_SERVICE_CREDENTIAL', 'test-service-credential-min-16-chars')

    const { runLocalAppMigrations } = await import('../../db/local-migrate.js')
    const { upsertLocalEnvRegistration } = await import('../../db/local-env-store.js')
    const { appRouter } = await import('../router.js')
    runLocalAppMigrations(sqlitePath)
    upsertLocalEnvRegistration({
      id: 'local-test',
      label: 'Local Test',
      url: 'http://127.0.0.1:48999',
      envToken: 'token-123',
      localIdentityLabel: 'Local Test',
    })

    const caller = appRouter.createCaller({
      session: { id: 'test', expiresAt: new Date(Date.now() + 60_000), lastSeen: new Date() },
      ip: '127.0.0.1',
      req: {} as never,
      res: {} as never,
    })
    const rows = await caller.env.list({})

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'local-test',
      kind: 'local',
      label: 'Local Test',
      url: 'http://127.0.0.1:48999',
      envToken: 'token-123',
    })
  })
})
