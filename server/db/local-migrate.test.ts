import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { localAppTables, runLocalAppMigrations } from './local-migrate'

describe('runLocalAppMigrations', () => {
  it('creates the local app SQLite schema', () => {
    const sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-sqlite-test-')), 'app.db')

    const result = runLocalAppMigrations(sqlitePath)

    expect(result).toEqual({ sqlitePath, applied: ['0001_local_app_schema'] })
    const sqlite = new Database(sqlitePath, { readonly: true })
    try {
      const rows = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
      const tableNames = new Set(rows.map((row) => row.name))
      for (const table of localAppTables) expect(tableNames.has(table)).toBe(true)
    } finally {
      sqlite.close()
    }
  })

  it('is idempotent', () => {
    const sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-sqlite-test-')), 'app.db')

    runLocalAppMigrations(sqlitePath)
    const result = runLocalAppMigrations(sqlitePath)

    expect(result).toEqual({ sqlitePath, applied: [] })
  })
})
