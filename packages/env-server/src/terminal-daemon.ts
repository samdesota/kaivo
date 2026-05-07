#!/usr/bin/env node
import { config } from './config.js'
import { runMigrations } from './db/migrate.js'
import { logger } from './logger.js'
import { listenTerminalDaemon } from './terminal/daemon-server.js'

async function main(): Promise<void> {
  if (!config.CC_TERMINAL_SOCKET) throw new Error('CC_TERMINAL_SOCKET is required')
  await runMigrations()
  await listenTerminalDaemon(config.CC_TERMINAL_SOCKET)
}

main().catch((err) => {
  logger.error({ err }, 'terminal daemon failed to start')
  process.exit(1)
})
