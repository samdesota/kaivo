import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import { env } from '../env.js'

fs.mkdirSync(path.dirname(env.APP_SQLITE_PATH), { recursive: true })

export const sqlite = new Database(env.APP_SQLITE_PATH)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })
export type Db = typeof db
