import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { config } from '../config.js'

fs.mkdirSync(config.CC_STATE_DIR, { recursive: true })

const sqlite = new Database(path.join(config.CC_STATE_DIR, 'env.db'))
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite)
export const sqliteRaw = sqlite
