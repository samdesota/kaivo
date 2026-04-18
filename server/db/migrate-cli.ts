import { pool } from './client.js'
import { runMigrations } from './migrate.js'
import { logger } from '../logger.js'

await runMigrations(pool)
logger.info('migrations applied')
await pool.end()
