import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

const roots: string[] = []

async function tempState(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'env-migrate-'))
  roots.push(root)
  vi.stubEnv('CC_STATE_DIR', root)
  vi.stubEnv('CC_WORKING_DIR', root)
  vi.stubEnv('CC_IDENTITY_URL', 'http://127.0.0.1:1')
  return root
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('env migrations', () => {
  it('migrates a fresh database, reruns idempotently, and survives restart', async () => {
    await tempState()
    let modules = await Promise.all([import('./migrate.js'), import('./client.js')])
    await modules[0].runMigrations()
    await modules[0].runMigrations()
    modules[1].sqliteRaw.prepare(`
      INSERT INTO agent_sessions (id, opencode_session_id, status, created_at, last_activity_at)
      VALUES ('chat-1', 'oc-chat-1', 'active', datetime('now'), datetime('now'))
    `).run()
    expect(modules[1].sqliteRaw.prepare('SELECT kind FROM agent_sessions WHERE id = ?').get('chat-1'))
      .toEqual({ kind: 'chat' })
    const migrationCount = (await fs.readdir(path.resolve('packages/env-server/migrations')))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name)).length
    expect((modules[1].sqliteRaw.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count)
      .toBe(migrationCount)
    modules[1].sqliteRaw.close()

    vi.resetModules()
    modules = await Promise.all([import('./migrate.js'), import('./client.js')])
    await modules[0].runMigrations()
    expect(modules[1].sqliteRaw.prepare('SELECT kind FROM agent_sessions WHERE id = ?').get('chat-1'))
      .toEqual({ kind: 'chat' })
    modules[1].sqliteRaw.close()
  })

  it('upgrades an existing database without changing legacy chat behavior', async () => {
    const root = await tempState()
    const raw = new Database(path.join(root, 'env.db'))
    raw.pragma('foreign_keys = ON')
    raw.exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, run_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    const migrationsDir = path.resolve('packages/env-server/migrations')
    for (const name of (await fs.readdir(migrationsDir)).filter((name) => /^000[1-9]_.*\.sql$|^0010_.*\.sql$/.test(name)).sort()) {
      raw.exec(await fs.readFile(path.join(migrationsDir, name), 'utf8'))
      raw.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name)
    }
    raw.prepare(`
      INSERT INTO agent_sessions (id, opencode_session_id, status, created_at, last_activity_at)
      VALUES ('legacy', 'oc-legacy', 'active', datetime('now'), datetime('now'))
    `).run()
    raw.close()

    const [{ runMigrations }, { sqliteRaw }] = await Promise.all([import('./migrate.js'), import('./client.js')])
    await runMigrations()
    expect(sqliteRaw.prepare('SELECT id, kind, status FROM agent_sessions WHERE id = ?').get('legacy'))
      .toEqual({ id: 'legacy', kind: 'chat', status: 'active' })
    expect(sqliteRaw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orchestration_subtasks'").get())
      .toBeTruthy()
    sqliteRaw.close()
  })
})
