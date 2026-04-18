import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'
import { env } from '../env.js'

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
})

export const db = drizzle(pool, { schema })
export { pool }
export type Db = typeof db
