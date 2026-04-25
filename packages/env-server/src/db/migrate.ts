import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sqliteRaw } from './client.js'
import { logger } from '../logger.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function findMigrationsDir(): Promise<string> {
  const candidates = [
    // Bundled deploys (install.sh + base-sandbox image) ship migrations
    // alongside main.js, so HERE is the right anchor.
    path.resolve(HERE, 'migrations'),
    path.resolve(HERE, '../migrations'),
    // Source / `tsx watch` runs main.js from src/, two levels above the
    // package's `migrations/` dir.
    path.resolve(HERE, '../../migrations'),
    path.resolve(HERE, '../../../migrations'),
    path.resolve(process.cwd(), 'migrations'),
  ]
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c)
      if (stat.isDirectory()) return c
    } catch {
      // continue
    }
  }
  throw new Error(`could not locate env-server migrations directory; tried: ${candidates.join(', ')}`)
}

export async function runMigrations(): Promise<void> {
  const dir = await findMigrationsDir()
  sqliteRaw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      run_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const applied = new Set(
    (sqliteRaw.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
      (r) => r.name,
    ),
  )
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await fs.readFile(path.join(dir, file), 'utf8')
    logger.info({ file }, 'applying migration')
    const trx = sqliteRaw.transaction(() => {
      sqliteRaw.exec(sql)
      sqliteRaw.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file)
    })
    trx()
  }
}
