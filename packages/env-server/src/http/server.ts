import crypto from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { allowedOrigins, config } from '../config.js'
import { logger } from '../logger.js'
import { appRouter } from '../trpc/router.js'
import { createContext } from '../trpc/trpc.js'
import { getMeta, hashEnvToken, isPaired } from '../envmeta/service.js'
import { terminalService } from '../terminal/service.js'
import { opencodeSupervisor } from '../agent/opencode.js'
import { registerAgentProxy } from '../agent/proxy.js'
import { getIdentityToken } from '../identity/client.js'

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    // tRPC's httpBatchLink concatenates procedure names into the URL path,
    // which can blow past Fastify's 100-char wildcard-param default; raise
    // it so 5+ batched procs aren't dropped to a 404 by the router.
    maxParamLength: 5000,
  })

  // CORS: explicit allowlist. No "*" — bearer tokens travel in headers so
  // we never want to echo arbitrary origins.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Vary', 'Origin')
      reply.header('Access-Control-Allow-Credentials', 'true')
      reply.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization',
      )
      reply.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, OPTIONS',
      )
    }
    if (req.method === 'OPTIONS') {
      reply.code(204).send()
    }
  })

  // Unauthenticated healthz. Orchestrator polls this; no bearer needed.
  app.get('/healthz', async () => {
    return {
      ok: true,
      paired: isPaired(),
      identityReady: getIdentityToken() !== null,
      opencodeReady: opencodeSupervisor.isReady(),
    }
  })

  await app.register(fastifyWebsocket)

  // `/agent/*` reverse proxy to local opencode server. Registered BEFORE
  // the PTY WS route so `/agent/*` upgrade requests match the proxy's
  // WS handler.
  registerAgentProxy(app)

  // PTY WebSocket. Auth: envToken in `?token=` query or first
  // text frame of the form `AUTH <token>`. The query flavor is more
  // convenient in browsers.
  app.register(async (scoped) => {
    scoped.get('/ws/shell/:id', { websocket: true } as never, async (socket, req) => {
      const id = (req.params as { id: string }).id
      const url = new URL(req.url, 'http://internal')
      const queryToken = url.searchParams.get('token')
      const ok = queryToken ? verifyEnvToken(queryToken) : false

      if (!ok) {
        socket.close(4401, 'unauthorized')
        return
      }

      let attached: { snapshot: string; detach: () => void } | null = null
      try {
        attached = terminalService.attach(id, (chunk: string) => {
          try {
            socket.send(chunk)
          } catch (err) {
            logger.warn({ err, id }, 'shell ws send failed')
          }
        })
      } catch {
        socket.close(4404, 'shell not found')
        return
      }

      // Replay the current scrollback so the UI starts with context.
      try {
        socket.send(attached.snapshot)
      } catch {
        // ignore; client may have closed already
      }

      socket.on('message', (data) => {
        const s = data.toString('utf8')
        try {
          terminalService.write(id, s)
        } catch (err) {
          logger.warn({ err, id }, 'shell ws write failed')
        }
      })

      socket.on('close', () => {
        attached?.detach()
      })
    })
  })

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  } as never)

  return app
}

function verifyEnvToken(token: string): boolean {
  const meta = getMeta()
  if (!meta.envTokenHash) return false
  const incoming = hashEnvToken(token)
  const a = Buffer.from(incoming)
  const b = Buffer.from(meta.envTokenHash)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
