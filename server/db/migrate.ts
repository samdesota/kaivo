import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { logger } from '../logger.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Look in a few plausible locations so this works from both source (tsx) and
 * the bundled dist/server/index.js where the file lives one level up.
 */
async function findMigrationsDir(): Promise<string> {
  const candidates = [
    path.resolve(HERE, '../../migrations'),
    path.resolve(HERE, '../migrations'),
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
  throw new Error(`could not locate migrations directory; tried: ${candidates.join(', ')}`)
}

export async function runMigrations(pool: Pool): Promise<void> {
  const dir = await findMigrationsDir()
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [file],
      )
      if (rowCount && rowCount > 0) continue

      const sql = await fs.readFile(path.join(dir, file), 'utf8')
      logger.info({ file }, 'applying migration')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    }
  } finally {
    client.release()
  }
}
