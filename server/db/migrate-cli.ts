import { env } from '../env.js'
import { runLocalAppMigrations } from './local-migrate.js'
import { logger } from '../logger.js'

const result = runLocalAppMigrations(env.APP_SQLITE_PATH)
logger.info(result, 'sqlite migrations applied')
