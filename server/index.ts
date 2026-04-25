import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from '@trpc/server/adapters/fastify'
import { env, isProd } from './env.js'
import { logger } from './logger.js'
import { pool } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { loadMasterKey } from './secrets/index.js'
import { seedAdminFromEnv, purgeExpiredSessions } from './auth/service.js'
import { appRouter, type AppRouter } from './trpc/router.js'
import { createContext } from './trpc/context.js'
import { dockerPing, ensureNetwork } from './docker/client.js'
import { sandboxManager } from './sandbox/manager.js'
import { registerShellWsRoutes } from './ws/shell.js'
import { registerGitHubRoutes } from './http/github.js'
import { registerPreviewProxy } from './preview/proxy.js'
import { registerAgentProxy } from './agent/proxy.js'
import { registerEnvProxy } from './env-orchestrator/proxy.js'
import { envReconciler } from './env-orchestrator/reconciler.js'
import { agentService } from './agent/service.js'
import { bootstrapProvidersFromEnv } from './agent/providers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function resolveStaticRoot(): Promise<string | null> {
  if (!isProd) return null
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

async function buildServer() {
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
  registerEnvProxy(server)
  registerGitHubRoutes(server)

  server.get('/healthz', async () => ({ ok: true }))

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
    })
    // SPA fallback for client-side routes. Proxy routes (`/preview/...`,
    // `/sandbox/:id/agent/...`) are intercepted by their own onRequest hooks
    // and will have already responded by the time not-found runs — but we
    // still return 404 on the off-chance, since the SPA doesn't own them.
    server.setNotFoundHandler((req, reply) => {
      if (
        req.url.startsWith('/trpc') ||
        req.url.startsWith('/api') ||
        req.url.startsWith('/agent') ||
        req.url.startsWith('/env/') ||
        req.url.startsWith('/preview/') ||
        /^\/sandbox\/[^/]+\/agent(\/|$)/.test(req.url)
      ) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return server
}

async function main() {
  await loadMasterKey()
  await runMigrations(pool)
  await seedAdminFromEnv()
  await bootstrapProvidersFromEnv()

  agentService.wireSandboxLifecycle()

  const dockerOk = await dockerPing()
  if (dockerOk) {
    try {
      await ensureNetwork(env.DOCKER_NETWORK)
      await sandboxManager.reconcile()
      // Kick off opencode on any surviving sandboxes. Non-fatal on failure.
      await agentService.reconcile()
      await envReconciler.reconcile()
    } catch (err) {
      logger.warn({ err }, 'sandbox reconcile failed')
    }
  } else {
    logger.warn(
      'docker daemon not reachable — sandbox create/list will fail until /var/run/docker.sock is mounted',
    )
  }

  const server = await buildServer()
  await server.listen({ port: env.PORT, host: env.HOST })
  logger.info(`listening on http://${env.HOST}:${env.PORT}`)

  const purgeTimer = setInterval(() => {
    purgeExpiredSessions().catch((err) => logger.warn({ err }, 'session purge failed'))
  }, 60_000)
  purgeTimer.unref()

  const reconcileTimer = setInterval(() => {
    sandboxManager.reconcile().catch((err) => logger.warn({ err }, 'reconcile failed'))
  }, 10_000)
  reconcileTimer.unref()

  const envReconcileTimer = setInterval(() => {
    envReconciler
      .reconcile()
      .catch((err) => logger.warn({ err }, 'env reconcile failed'))
  }, 15_000)
  envReconcileTimer.unref()

  // Re-bootstrap opencode on any sandbox where the process has died; longer
  // interval than the sandbox reconcile because the ready-probe inside each
  // call is an HTTP round-trip per sandbox.
  const agentReconcileTimer = setInterval(() => {
    agentService
      .reconcile()
      .catch((err) => logger.warn({ err }, 'agent reconcile failed'))
  }, 30_000)
  agentReconcileTimer.unref()

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    clearInterval(purgeTimer)
    clearInterval(reconcileTimer)
    clearInterval(envReconcileTimer)
    clearInterval(agentReconcileTimer)
    try {
      await server.close()
      await pool.end()
    } catch (err) {
      logger.error({ err }, 'error during shutdown')
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error')
  process.exit(1)
})
