import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from '@trpc/server/adapters/fastify'
import { env, isProd } from './env.js'
import { logger } from './logger.js'
import { runLocalAppMigrations } from './db/local-migrate.js'
import { getLocalEnvRegistration, upsertLocalEnvRegistration } from './db/local-env-store.js'
import { loadMasterKey } from './secrets/index.js'
import { seedAdminFromEnv, purgeExpiredSessions } from './auth/service.js'
import { appRouter, type AppRouter } from './trpc/router.js'
import { createContext } from './trpc/context.js'
import { initializeAppRealtime } from './realtime/app-realtime.js'
import { registerShellWsRoutes } from './ws/shell.js'
import { registerGitHubRoutes } from './http/github.js'
import { registerPreviewProxy } from './preview/proxy.js'
import { registerAgentProxy } from './agent/proxy.js'
import { purgeExpiredLogs } from './logs/service.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function resolveStaticRoot(): Promise<string | null> {
  if (!isProd && !env.CC_SERVE_CLIENT) return null
  const candidates = [
    path.resolve(HERE, '../client'),
    path.resolve(HERE, '../../dist/client'),
    path.resolve(process.cwd(), 'dist/client'),
  ]
  for (const c of candidates) {
    try {
      const stat = await fs.stat(path.join(c, 'index.html'))
      if (stat.isFile()) return c
    } catch {
      // continue
    }
  }
  return null
}

export async function buildServer() {
  const server = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024, // 10 MB
    // tRPC's httpBatchLink concatenates procedure names into the URL path,
    // which can blow past Fastify's 100-char wildcard-param default; raise
    // it so 5+ batched procs aren't dropped to a 404 by the router.
    maxParamLength: 5000,
  })

  await server.register(fastifyCookie, {})
  await registerShellWsRoutes(server)
  registerPreviewProxy(server)
  registerAgentProxy(server)
  registerGitHubRoutes(server)
  initializeAppRealtime()

  server.get('/healthz', async () => ({ ok: true, instanceId: env.CC_INSTANCE_ID }))

  server.get<{ Params: { id: string } }>('/internal/local-env/:id', async (req, reply) => {
    const row = getLocalEnvRegistration(req.params.id)
    if (!row) return reply.code(404).send({ error: 'not found' })
    return row
  })

  server.post('/internal/local-env/register', async (req, reply) => {
    const body = req.body as Partial<{
      id: string
      instanceId: string
      label: string
      url: string
      envToken: string
      localIdentityLabel: string
    }>
    if (!body.id || !body.instanceId || !body.label || !body.url || !body.envToken || !body.localIdentityLabel) {
      return reply.code(400).send({ error: 'missing fields' })
    }
    if (body.instanceId !== env.CC_INSTANCE_ID) {
      return reply.code(409).send({ error: 'instance mismatch' })
    }
    return upsertLocalEnvRegistration({
      id: body.id,
      label: body.label,
      url: body.url,
      envToken: body.envToken,
      localIdentityLabel: body.localIdentityLabel,
    })
  })

  // Caddy on-demand TLS gate: returns 200 only for hostnames that parse as
  // a valid preview subdomain (existing or otherwise — we don't hit the DB
  // since the sandbox might not be running yet, and we want certs ready).
  server.get<{ Querystring: { domain?: string } }>('/internal/ask-tls', async (req, reply) => {
    const domain = (req.query?.domain ?? '').toLowerCase()
    if (!domain) return reply.code(400).send('missing domain')
    if (domain === env.PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/.*$/, '')) {
      return reply.code(200).send('ok')
    }
    const apex = env.PREVIEW_HOSTNAME?.toLowerCase()
    if (!apex || !domain.endsWith('.' + apex)) {
      return reply.code(404).send('unknown')
    }
    const sub = domain.slice(0, -('.' + apex).length)
    if (!/^[a-z0-9]+-\d+$/.test(sub)) return reply.code(404).send('invalid')
    return reply.code(200).send('ok')
  })

  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    useWSS: true,
    trpcOptions: {
      router: appRouter,
      createContext,
      onError({ error, path: p }) {
        logger.warn({ path: p, err: error.message }, 'trpc error')
      },
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>)

  const staticRoot = await resolveStaticRoot()
  if (staticRoot) {
    logger.info({ staticRoot }, 'serving SPA')
    await server.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      index: ['index.html'],
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-store')
        }
      },
    })
    // SPA fallback for client-side routes. Proxy routes (`/preview/...`,
    // `/sandbox/:id/agent/...`) are intercepted by their own onRequest hooks
    // and will have already responded by the time not-found runs — but we
    // still return 404 on the off-chance, since the SPA doesn't own them.
    server.setNotFoundHandler((req, reply) => {
      // /env/<id> is a SPA route too — the orchestrator's reverse proxy
      // only intercepts /env/<id>/<rest> for container envs (and short-
      // circuits earlier), so anything reaching not-found is browser
      // navigation that should land on index.html.
      if (
        req.url.startsWith('/trpc') ||
        req.url.startsWith('/api') ||
        req.url.startsWith('/agent') ||
        req.url.startsWith('/preview/') ||
        /^\/sandbox\/[^/]+\/agent(\/|$)/.test(req.url)
      ) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.header('Cache-Control', 'no-store').sendFile('index.html')
    })
  }

  return server
}

async function main() {
  await loadMasterKey()
  runLocalAppMigrations(env.APP_SQLITE_PATH)
  await seedAdminFromEnv()

  const server = await buildServer()
  await server.listen({ port: env.PORT, host: env.HOST })
  logger.info(`listening on http://${env.HOST}:${env.PORT}`)

  const purgeTimer = setInterval(() => {
    purgeExpiredSessions().catch((err) => logger.warn({ err }, 'session purge failed'))
  }, 60_000)
  purgeTimer.unref()

  // event_logs retention sweep. Daily is plenty given the table is
  // append-only and the index on event_ts makes the range delete cheap.
  const logRetentionTimer = setInterval(() => {
    purgeExpiredLogs()
      .then((n) => {
        if (n > 0) logger.info({ purged: n }, 'event_logs retention sweep')
      })
      .catch((err) => logger.warn({ err }, 'event_logs purge failed'))
  }, 24 * 60 * 60 * 1000)
  logRetentionTimer.unref()

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    clearInterval(purgeTimer)
    try {
      await server.close()
    } catch (err) {
      logger.error({ err }, 'error during shutdown')
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    logger.error({ err }, 'fatal startup error')
    process.exit(1)
  })
}
