import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { config } from '../config.js'
import { isAllowedOrigin } from './cors.js'
import { logger } from '../logger.js'
import { appRouter } from '../trpc/router.js'
import { createContext } from '../trpc/trpc.js'
import { FsError, readRawFile } from '../fs/service.js'
import { getMeta, hashEnvToken, hasEnvTokenHash, isPaired } from '../envmeta/service.js'
import { desktopPair, PairError } from '../pair/service.js'
import { terminalService } from '../terminal/service.js'
import { terminalDaemonClient, useTerminalDaemon } from '../terminal/daemon-client.js'
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
    if (typeof origin === 'string' && isAllowedOrigin(origin)) {
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
      kind: config.CC_KIND,
      instanceId: config.CC_INSTANCE_ID,
      label: config.CC_LABEL,
      identityReady: getIdentityToken() !== null,
      opencodeReady: opencodeSupervisor.isReady(),
    }
  })

  app.get('/auth/check', async (req, reply) => {
    const headerVal = req.headers.authorization
    const header = Array.isArray(headerVal) ? headerVal[0] : headerVal
    const token = typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : ''
    if (!token || !hasEnvTokenHash(hashEnvToken(token))) return reply.code(401).send({ ok: false })
    return { ok: true, instanceId: config.CC_INSTANCE_ID }
  })

  app.get('/fs/raw', async (req, reply) => {
    const query = req.query as { path?: string; absolute?: string; token?: string } | undefined
    const token = query?.token ?? bearerToken(req.headers.authorization)
    if (!token || !hasEnvTokenHash(hashEnvToken(token))) return reply.code(401).send({ error: 'unauthorized' })
    if (!query?.path) return reply.code(400).send({ error: 'path required' })

    try {
      const file = await readRawFile(query.path, { absolute: query.absolute === 'true' })
      reply
        .header('content-type', contentTypeForPath(file.path))
        .header('cache-control', 'no-store')
        .header('last-modified', file.mtime.toUTCString())
      return reply.send(file.content)
    } catch (err) {
      if (err instanceof FsError) {
        const status = err.code === 'not_found' ? 404 : err.code === 'path_traversal' ? 400 : 400
        return reply.code(status).send({ error: err.message })
      }
      throw err
    }
  })

  app.post('/pair/desktop', async (req, reply) => {
    const body = req.body as { instanceId?: string; identityToken?: string } | undefined
    try {
      return await desktopPair(body?.instanceId ?? '', body?.identityToken)
    } catch (err) {
      if (err instanceof PairError && err.code === 'instance_mismatch') {
        return reply.code(409).send({ error: err.message })
      }
      throw err
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

      if (useTerminalDaemon()) {
        const upstream = terminalDaemonClient.attachWebSocket(id)
        upstream.on('message', (data) => {
          try {
            socket.send(data.toString())
          } catch (err) {
            logger.warn({ err, id }, 'shell daemon proxy send failed')
          }
        })
        upstream.on('close', (code, reason) => {
          const closeCode = code >= 1000 && code < 5000 && code !== 1006 ? code : 1011
          socket.close(closeCode, reason.toString())
        })
        upstream.on('error', (err) => {
          logger.warn({ err, id }, 'shell daemon proxy failed')
          socket.close(4404, 'shell daemon unavailable')
        })
        socket.on('message', (data) => {
          if (upstream.readyState === 1) upstream.send(data)
        })
        socket.on('close', () => upstream.close())
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
    // Enable WS subscriptions on the same /trpc endpoint so the webapp's
    // wsLink (preview.ports, agent.transcript) can connect.
    useWSS: true,
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  } as never)

  return app
}

function verifyEnvToken(token: string): boolean {
  return hasEnvTokenHash(hashEnvToken(token))
}

function bearerToken(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value
  return typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : null
}

function contentTypeForPath(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop()
  switch (ext) {
    case 'apng': return 'image/apng'
    case 'avif': return 'image/avif'
    case 'gif': return 'image/gif'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'svg': return 'image/svg+xml'
    case 'webp': return 'image/webp'
    default: return 'application/octet-stream'
  }
}
