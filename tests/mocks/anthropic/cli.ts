import { createAnthropicMock } from './server.js'

const port = Number(process.env.MOCK_ANTHROPIC_PORT ?? process.env.PORT ?? 3101)
const host = process.env.MOCK_ANTHROPIC_HOST ?? '127.0.0.1'

createAnthropicMock({ port, host })
  .then((mock) => {
    console.log(`[anthropic-mock] listening on ${mock.url}`)

    const shutdown = async () => {
      await mock.close()
      process.exit(0)
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  })
  .catch((err) => {
    console.error('[anthropic-mock] failed to start', err)
    process.exit(1)
  })
