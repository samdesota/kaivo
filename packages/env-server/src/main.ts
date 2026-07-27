#!/usr/bin/env node
import { config } from './config.js'
import { runMigrations } from './db/migrate.js'
import { initEnvMetaFromSecrets, isPaired } from './envmeta/service.js'
import { buildServer } from './http/server.js'
import { logger } from './logger.js'
import { terminalService } from './terminal/service.js'
import { initIdentityToken } from './identity/client.js'
import { ensureOpencodeBootstrapped, opencodeSupervisor } from './agent/opencode.js'
import { initializeEnvRealtime } from './realtime/env-realtime.js'
import { orchestrationService } from './orchestration/service.js'
import { orchestrationTurnObserver } from './orchestration/turn-observer.js'
import { getOrchestrationRealtime } from './orchestration/realtime.js'

async function main(): Promise<void> {
  await runMigrations()
  initializeEnvRealtime()
  getOrchestrationRealtime().start()
  await initEnvMetaFromSecrets()
  await initIdentityToken()

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

  // Best-effort opencode start; no-ops if identity token/provider keys
  // aren't available yet. Runs in background so slow opencode boot doesn't
  // block http listen.
  orchestrationTurnObserver.start()
  void (async () => {
    let opencodeReady = true
    try {
      await ensureOpencodeBootstrapped()
    } catch (err) {
      opencodeReady = false
      logger.warn({ err }, 'opencode unavailable during startup reconciliation')
    }
    try {
      const provisioning = await orchestrationService.reconcileAll()
      for (const outcome of provisioning) {
        const log = outcome.outcome === 'failed' ? logger.warn.bind(logger) : logger.info.bind(logger)
        log({ ...outcome }, 'orchestration task startup reconciliation')
      }
    } catch (err) {
      logger.warn({ err }, 'orchestration provisioning reconciliation failed')
    }
    if (!opencodeReady) {
      logger.warn('skipping startup return reconciliation while opencode is unavailable')
      return
    }
    const returns = await orchestrationTurnObserver.reconcileAll()
    for (const outcome of returns) {
      const log = outcome.outcome === 'failed' ? logger.warn.bind(logger) : logger.info.bind(logger)
      log({ ...outcome }, 'orchestration return startup reconciliation')
    }
  })().catch((err) => logger.warn({ err }, 'orchestration startup reconciliation failed'))

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down')
    try {
      opencodeSupervisor.stop()
    } catch (err) {
      logger.warn({ err }, 'opencode stop errored')
    }
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
