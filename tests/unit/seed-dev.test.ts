import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

const seedEnvKeys = [
  'NODE_ENV',
  'APP_SQLITE_PATH',
  'DATA_DIR',
  'CC_INSTANCE_ID',
  'CC_INSTANCE_ROOT',
  'CC_APP_DATA_DIR',
  'CC_APP_SQLITE_PATH',
  'CC_SERVICE_CREDENTIAL',
  'CC_SEED_OPENAI_API_KEY',
  'CC_SEED_OPENAI_API_KEY_OP_REF',
  'CC_SEED_OPENAI_BASE_URL',
  'CC_SEED_MODEL_PROVIDER',
  'CC_SEED_MODEL_ID',
  'CC_SEED_FORCE',
]

describe('runDevSeed', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    for (const key of seedEnvKeys) delete process.env[key]
  })

  it('seeds the selected app DB idempotently and updates provider values', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seed-dev-test-'))
    const sqlitePath = path.join(dataDir, 'app.db')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('DATA_DIR', dataDir)
    vi.stubEnv('APP_SQLITE_PATH', sqlitePath)
    vi.stubEnv('CC_SEED_OPENAI_API_KEY_OP_REF', '')
    vi.stubEnv('CC_SEED_OPENAI_API_KEY', 'key-one')
    vi.stubEnv('CC_SEED_OPENAI_BASE_URL', 'http://localhost:11434/v1')
    vi.stubEnv('CC_SEED_MODEL_PROVIDER', 'openai')
    vi.stubEnv('CC_SEED_MODEL_ID', 'gpt-test')

    const { runDevSeed } = await import('../../scripts/seed-dev')
    await runDevSeed({ cwd: '/tmp/worktree-a', log: () => {} })
    vi.stubEnv('CC_SEED_OPENAI_API_KEY', 'key-two')
    await runDevSeed({ cwd: '/tmp/worktree-a', log: () => {} })

    const { getSecret } = await import('../../server/secrets/index')
    const { buildProviderEnvRaw } = await import('../../server/agent/providers')
    const sqlite = new Database(sqlitePath, { readonly: true })
    try {
      expect(await getSecret('provider.openai.api_key')).toBe('key-two')
      expect(await getSecret('provider.openai.base_url')).toBe('http://localhost:11434/v1')
      expect(await getSecret('agent.default_model')).toBe(JSON.stringify({ providerID: 'openai', modelID: 'gpt-test' }))
      expect(await buildProviderEnvRaw()).toEqual({
        OPENAI_API_KEY: 'key-two',
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
      })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM admin WHERE id = 1').get()).toEqual({ count: 1 })
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM secrets WHERE name = 'provider.openai.api_key'").get()).toEqual({ count: 1 })
    } finally {
      sqlite.close()
    }
  })

  it('refuses production seeding without the force flag', async () => {
    const { runDevSeed } = await import('../../scripts/seed-dev')

    await expect(runDevSeed({ env: { NODE_ENV: 'production' }, log: () => {} })).rejects.toThrow(/Refusing to run dev seed/)
  })
})
