import http from 'node:http'
import { WebSocket } from 'ws'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { envs } from '../db/schema.js'
import { env as appEnv } from '../env.js'
import { getDocker } from '../docker/client.js'
import { logger } from '../logger.js'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

const ENV_PORT = 47821

interface ParsedEnvUrl {
  envId: string
  rest: string
}

/**
 * `/env/<id>/<rest?>` — strip the `/env/<id>` prefix and return the
 * remaining path + query. Returns null for anything else.
 */
export function parseEnvUrl(url: string): ParsedEnvUrl | null {
  if (!url.startsWith('/env/')) return null
  const qIdx = url.indexOf('?')
  const pathOnly = qIdx < 0 ? url : url.slice(0, qIdx)
  const query = qIdx < 0 ? '' : url.slice(qIdx)
  const rest = pathOnly.slice('/env/'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) {
    // `/env/<id>` with no trailing slash — treat as root.
    const envId = rest
    if (!envId) return null
    return { envId, rest: '/' + query }
  }
  const envId = rest.slice(0, slash)
  const tail = rest.slice(slash)
  if (!envId) return null
  return { envId, rest: tail + query }
}

function filterRequestHeaders(
  headers: http.IncomingHttpHeaders,
  upstreamHost: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (v !== undefined) out[k] = v as string | string[]
  }
  out.host = upstreamHost
  return out
}

function filterResponseHeaders(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (v !== undefined) out[k] = v as string | string[]
  }
  return out
}

/**
 * Resolve a container env's loopback-ish IP on the shared docker network.
 * Orchestrator-side cache is unnecessary — this is only hit on connection
 * setup, and the docker engine's inspect is ~sub-ms locally.
 */
async function resolveContainerIp(containerId: string): Promise<string | null> {
  try {
    const info = await getDocker().getContainer(containerId).inspect()
    const networks = info.NetworkSettings?.Networks ?? {}
    const preferred = networks[appEnv.DOCKER_NETWORK]
    const ip =
      preferred?.IPAddress ||
      Object.values(networks).find((n) => n?.IPAddress)?.IPAddress ||
      null
    return ip || null
  } catch (err) {
    logger.warn({ err, containerId }, 'container inspect failed')
    return null
  }
}

/**
 * Tri-state: 'skip' = not our concern (let the SPA / next handler take it),
 * 'unavailable' = container env we know about but can't currently reach,
 * { ip } = ready to proxy.
 */
async function resolveEnvUpstream(
  envId: string,
): Promise<'skip' | 'unavailable' | { ip: string }> {
  const rows = await db.select().from(envs).where(eq(envs.id, envId)).limit(1)
  const row = rows[0]
  // Unknown envs / local envs: bow out so the SPA can serve `/env/:id` and
  // the browser talks to the local env directly via its own loopback URL.
  if (!row || row.kind !== 'container') return 'skip'
  if (!row.containerId) return 'unavailable'
  const ip = await resolveContainerIp(row.containerId)
  if (!ip) return 'unavailable'
  return { ip }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerEnvProxy(app: any): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseEnvUrl(req.url)
    if (!parsed) return
    if ((req.headers.upgrade ?? '').toString().toLowerCase() === 'websocket') return
    await handleHttp(req, reply, parsed)
  })

  // Fastify WS routes for `/env/:envId/*`. @fastify/websocket owns the
  // upgrade listener, so regular onRequest hooks don't see WS upgrades.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.register(async (scoped: any) => {
    for (const route of ['/env/:envId', '/env/:envId/*']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scoped.get(route, { websocket: true } as never, async (socket: any, req: any) => {
        const parsed = parseEnvUrl(req.url as string)
        if (!parsed) {
          safeClose(socket, 4400, 'invalid env url')
          return
        }
        await handleWs(socket, req, parsed)
      })
    }
  })
}

async function handleHttp(
  req: FastifyRequest,
  reply: FastifyReply,
  parsed: ParsedEnvUrl,
): Promise<void> {
  const upstream = await resolveEnvUpstream(parsed.envId)
  if (upstream === 'skip') return
  if (upstream === 'unavailable') {
    reply.code(502).send({ error: 'env upstream unavailable' })
    return
  }
  const upstreamHost = `${upstream.ip}:${ENV_PORT}`
  const outgoing = filterRequestHeaders(req.headers, upstreamHost)

  const upstreamReq = http.request({
    host: upstream.ip,
    port: ENV_PORT,
    method: req.method,
    path: parsed.rest,
    headers: outgoing,
  })

  reply.hijack()
  const downstream = reply.raw
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    upstreamReq.on('response', (upstreamRes) => {
      const headers = filterResponseHeaders(upstreamRes.headers)
      try {
        downstream.writeHead(upstreamRes.statusCode ?? 502, headers)
      } catch (err) {
        logger.warn({ err }, 'env proxy writeHead failed')
        done()
        return
      }
      upstreamRes.pipe(downstream)
      upstreamRes.on('end', done)
      upstreamRes.on('error', (err) => {
        logger.warn({ err }, 'env proxy upstream res error')
        try {
          downstream.end()
        } catch {
          // ignore
        }
        done()
      })
    })
    upstreamReq.on('error', (err) => {
      logger.warn({ err, host: upstreamHost }, 'env proxy connect error')
      try {
        if (!downstream.headersSent) {
          downstream.writeHead(502, { 'content-type': 'application/json' })
          downstream.end(JSON.stringify({ error: 'bad gateway' }))
        } else {
          downstream.end()
        }
      } catch {
        // ignore
      }
      done()
    })
    req.raw.on('error', () => {
      try {
        upstreamReq.destroy()
      } catch {
        // ignore
      }
    })
    req.raw.pipe(upstreamReq)
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleWs(clientSocket: any, req: any, parsed: ParsedEnvUrl): Promise<void> {
  const upstream = await resolveEnvUpstream(parsed.envId)
  if (upstream === 'skip' || upstream === 'unavailable') {
    safeClose(clientSocket, 4502, 'env upstream unavailable')
    return
  }
  const subHeader = req.headers['sec-websocket-protocol']
  const subprotocols =
    typeof subHeader === 'string'
      ? subHeader.split(',').map((s: string) => s.trim()).filter(Boolean)
      : undefined

  const upstreamWs = new WebSocket(
    `ws://${upstream.ip}:${ENV_PORT}${parsed.rest}`,
    subprotocols,
  )
  let opened = false
  upstreamWs.on('open', () => {
    opened = true
    bridge(clientSocket, upstreamWs)
  })
  upstreamWs.on('error', (err) => {
    logger.warn({ err }, 'env ws upstream error')
    if (!opened) safeClose(clientSocket, 4502, 'upstream connect failed')
  })
  upstreamWs.on('unexpected-response', (_r, upRes) => {
    safeClose(clientSocket, 4502, `upstream ${upRes.statusCode ?? 'error'}`)
  })
  clientSocket.once('close', () => {
    if (!opened) {
      try {
        upstreamWs.terminate()
      } catch {
        // ignore
      }
    }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bridge(a: any, b: WebSocket): void {
  a.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (b.readyState === WebSocket.OPEN) b.send(data, { binary: isBinary })
  })
  b.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (a.readyState === WebSocket.OPEN) a.send(data, { binary: isBinary })
  })
  const closeBoth = (code = 1000, reason = '') => {
    safeClose(a, code, reason)
    safeClose(b, code, reason)
  }
  a.on('close', (code: number, reason: Buffer) => closeBoth(code, reason.toString()))
  b.on('close', (code, reason) => closeBoth(code, reason.toString()))
  a.on('error', () => closeBoth(1011, 'peer error'))
  b.on('error', () => closeBoth(1011, 'peer error'))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeClose(ws: any, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    try {
      ws.terminate()
    } catch {
      // ignore
    }
  }
}
