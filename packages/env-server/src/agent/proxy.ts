import http from 'node:http'
import { WebSocket } from 'ws'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { isPaired, getMeta, hashEnvToken } from '../envmeta/service.js'
import { logger } from '../logger.js'
import { opencodeBasicAuthHeader, opencodeSupervisor } from './opencode.js'
import crypto from 'node:crypto'

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

const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
])

const AGENT_PREFIX = '/agent'

function verifyEnvToken(token: string): boolean {
  if (!isPaired()) return false
  const meta = getMeta()
  if (!meta.envTokenHash) return false
  const incoming = hashEnvToken(token)
  const a = Buffer.from(incoming)
  const b = Buffer.from(meta.envTokenHash)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function extractBearer(req: FastifyRequest): string | null {
  const hdr = req.headers['authorization']
  const value = Array.isArray(hdr) ? hdr[0] : hdr
  if (typeof value !== 'string') {
    const q = req.query as { token?: string } | undefined
    return q?.token ?? null
  }
  const m = /^bearer\s+(\S+)$/i.exec(value)
  return m ? m[1]! : null
}

function stripAgentPrefix(url: string): string {
  if (!url.startsWith(AGENT_PREFIX)) return '/'
  const tail = url.slice(AGENT_PREFIX.length)
  if (tail === '' || tail === '?') return '/'
  return tail.startsWith('/') || tail.startsWith('?') ? tail : '/' + tail
}

function filterRequestHeaders(
  headers: http.IncomingHttpHeaders,
  upstreamHost: string,
  password: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'authorization') continue
    if (lower === 'accept-encoding') continue
    if (v !== undefined) out[k] = v as string | string[]
  }
  out.host = upstreamHost
  out.authorization = opencodeBasicAuthHeader(password)
  out['accept-encoding'] = 'identity'
  return out
}

function filterResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (STRIP_RESPONSE_HEADERS.has(lower)) continue
    if (v !== undefined) out[k] = v as string | string[]
  }
  return out
}

/**
 * Register `/agent/*` reverse proxy to the local opencode server. HTTP via
 * `onRequest` hook, WebSocket via a dedicated fastify websocket route
 * (because @fastify/websocket installs its own upgrade listener).
 *
 * Auth: bearer envToken in the `Authorization` header, or `?token=` query
 * param for the WS case (browsers can't set headers on upgrade requests).
 */
export function registerAgentProxy(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith(AGENT_PREFIX)) return
    if ((req.headers.upgrade ?? '').toString().toLowerCase() === 'websocket') return
    await handleHttp(req, reply)
  })

  app.register(async (scoped) => {
    scoped.get('/agent', { websocket: true } as never, async (socket, req) => {
      await handleWs(socket as unknown as WebSocket, req)
    })
    scoped.get('/agent/*', { websocket: true } as never, async (socket, req) => {
      await handleWs(socket as unknown as WebSocket, req)
    })
  })
}

async function handleHttp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractBearer(req)
  if (!token || !verifyEnvToken(token)) {
    reply.code(401).send({ error: 'unauthorized' })
    return
  }
  const ep = opencodeSupervisor.currentEndpoint()
  if (!ep || !opencodeSupervisor.isReady()) {
    reply.code(503).send({ error: 'opencode not running' })
    return
  }
  const rest = stripAgentPrefix(req.url)
  const upstreamHost = `${ep.host}:${ep.port}`
  const outgoing = filterRequestHeaders(req.headers, upstreamHost, ep.password)

  const upstreamReq = http.request({
    host: ep.host,
    port: ep.port,
    method: req.method,
    path: rest,
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
        logger.warn({ err }, 'agent proxy writeHead failed')
        done()
        return
      }
      upstreamRes.pipe(downstream)
      upstreamRes.on('end', done)
      upstreamRes.on('error', (err) => {
        logger.warn({ err }, 'agent proxy upstream error')
        try {
          downstream.end()
        } catch {
          // ignore
        }
        done()
      })
    })
    upstreamReq.on('error', (err) => {
      logger.warn({ err, host: upstreamHost }, 'agent proxy connect error')
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

async function handleWs(clientSocket: WebSocket, req: FastifyRequest): Promise<void> {
  const token = extractBearer(req)
  if (!token || !verifyEnvToken(token)) {
    safeClose(clientSocket, 4401, 'unauthorized')
    return
  }
  const ep = opencodeSupervisor.currentEndpoint()
  if (!ep || !opencodeSupervisor.isReady()) {
    safeClose(clientSocket, 4503, 'opencode not running')
    return
  }
  const rest = stripAgentPrefix(req.url)
  const subHeader = req.headers['sec-websocket-protocol']
  const subprotocols =
    typeof subHeader === 'string'
      ? subHeader.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined

  const upstream = new WebSocket(
    `ws://${ep.host}:${ep.port}${rest}`,
    subprotocols,
    { headers: { authorization: opencodeBasicAuthHeader(ep.password) } },
  )
  let opened = false
  upstream.on('open', () => {
    opened = true
    bridge(clientSocket, upstream)
  })
  upstream.on('error', (err) => {
    logger.warn({ err }, 'agent ws upstream error')
    if (!opened) safeClose(clientSocket, 4502, 'upstream connect failed')
  })
  upstream.on('unexpected-response', (_r, upRes) => {
    safeClose(clientSocket, 4502, `upstream ${upRes.statusCode ?? 'error'}`)
  })
  clientSocket.once('close', () => {
    if (!opened) {
      try {
        upstream.terminate()
      } catch {
        // ignore
      }
    }
  })
}

function bridge(a: WebSocket, b: WebSocket): void {
  a.on('message', (data, isBinary) => {
    if (b.readyState === WebSocket.OPEN) b.send(data, { binary: isBinary })
  })
  b.on('message', (data, isBinary) => {
    if (a.readyState === WebSocket.OPEN) a.send(data, { binary: isBinary })
  })
  const closeBoth = (code = 1000, reason = '') => {
    safeClose(a, code, reason)
    safeClose(b, code, reason)
  }
  a.on('close', (code, reason) => closeBoth(code, reason.toString()))
  b.on('close', (code, reason) => closeBoth(code, reason.toString()))
  a.on('error', () => closeBoth(1011, 'peer error'))
  b.on('error', () => closeBoth(1011, 'peer error'))
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
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
