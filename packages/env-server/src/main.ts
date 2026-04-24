#!/usr/bin/env node
import { config } from './config.js'
import { runMigrations } from './db/migrate.js'
import { initEnvMetaFromSecrets, isPaired } from './envmeta/service.js'
import { buildServer } from './http/server.js'
import { logger } from './logger.js'
import { terminalService } from './terminal/service.js'

async function main(): Promise<void> {
  await runMigrations()
  await initEnvMetaFromSecrets()

  const app = await buildServer()
  await app.listen({ port: config.CC_PORT, host: config.CC_HOST })

  logger.info(
    {
      port: config.CC_PORT,
      host: config.CC_HOST,
      workingDir: config.CC_WORKING_DIR,
      paired: isPaired(),
    },
    'cc-env listening',
  )
  if (!isPaired()) {
    logger.info('env is unpaired; pair.start will accept unauthenticated calls')
  }

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down')
    terminalService.shutdownAll()
    try {
      await app.close()
    } catch (err) {
      logger.warn({ err }, 'fastify close errored')
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.error({ err }, 'cc-env failed to start')
  process.exit(1)
})
