import http from 'node:http'
import { WebSocket } from 'ws'
import { logger } from '../logger.js'
import { resolveSession } from '../auth/service.js'
import { SESSION_COOKIE } from '../auth/cookie.js'
import { previewService } from './service.js'
import { sandboxManager } from '../sandbox/manager.js'

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
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
])

function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() !== name) continue
    return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return null
}

async function isAuthed(cookieHeader: string | undefined): Promise<boolean> {
  const sid = parseCookieHeader(cookieHeader, SESSION_COOKIE)
  if (!sid) return false
  const session = await resolveSession(sid)
  return session !== null
}

/**
 * Parse /preview/:sandboxId/:port/<tail?>[<query?>] into parts. We forward
 * the FULL request path upstream (including the /preview/<sbid>/<port>/
 * prefix) so dev servers like Vite — which 302-redirect on base mismatch —
 * see a URL that matches their configured `base` and don't bounce the
 * browser, causing a redirect loop. Static servers like `python3 -m
 * http.server` need the prefix stripped or symlinked instead; that is a
 * known v1 limitation of path-based previews.
 */
export function parsePreviewUrl(
  url: string,
): { sandboxId: string; port: number; rest: string } | null {
  if (!url.startsWith('/preview/')) return null
  const qIdx = url.indexOf('?')
  const path = qIdx < 0 ? url : url.slice(0, qIdx)

  const segs = path.split('/') // ['', 'preview', sandboxId, port, ...rest]
  if (segs.length < 4) return null
  const sandboxId = segs[2] ?? ''
  const portStr = segs[3] ?? ''
  if (!sandboxId || !portStr) return null
  const port = Number(portStr)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  // Preserve the full path so base-aware dev servers (Vite with
  // base=/preview/<id>/<port>/, Next.js with basePath, etc.) see the prefix
  // they were configured with. Stripping would make vite redirect to its
  // base, which our proxy would strip again → infinite 302 loop.
  // Simple servers without a base (python -m http.server, static nginx)
  // need to be started in a directory whose layout matches the prefix, or
  // proxied with a URL-rewriter in front.
  return { sandboxId, port, rest: url }
}

function filterRequestHeaders(
  headers: http.IncomingHttpHeaders,
  upstreamHost: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'cookie') continue
    if (v !== undefined) out[k] = v as string | string[]
  }
  out.host = upstreamHost
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
 * Register the preview reverse proxy. HTTP requests are intercepted via an
 * onRequest hook (runs before body parsing). WebSocket upgrades are handled
 * by registering a `@fastify/websocket` route — this is required because
 * fastify-websocket installs its own upgrade listener that routes ALL
 * upgrade events through Fastify's router; if we tried to handle the
 * upgrade ourselves on the raw http.Server, fastify-websocket would race
 * us, treat the URL as unknown, and write an HTTP error to the socket
 * before our handler could open the upstream WS.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPreviewProxy(server: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.addHook('onRequest', async (req: any, reply: any) => {
    if (!req.url.startsWith('/preview/')) return
    // Skip upgrades — fastify-websocket route below handles them.
    if ((req.headers.upgrade ?? '').toString().toLowerCase() === 'websocket') return
    await handleHttp(req, reply)
  })

  // Register a WS route for /preview/<sb>/<port>/* (and bare prefix).
  for (const path of ['/preview/:sandboxId/:port', '/preview/:sandboxId/:port/*']) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.get(path, { websocket: true }, async (clientSocket: any, req: any) => {
      await handleWsRoute(clientSocket, req)
    })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleWsRoute(clientSocket: WebSocket, req: any): Promise<void> {
  if (!(await isAuthed(req.headers.cookie as string | undefined))) {
    safeClose(clientSocket, 4401, 'unauthorized')
    return
  }
  const parsed = parsePreviewUrl(req.url as string)
  if (!parsed) {
    safeClose(clientSocket, 4400, 'invalid preview url')
    return
  }
  const sb = await sandboxManager.get(parsed.sandboxId)
  if (!sb || !sb.running || !sb.containerId) {
    safeClose(clientSocket, 4503, 'sandbox not running')
    return
  }
  const ip = await previewService.getContainerIp(parsed.sandboxId)
  if (!ip) {
    safeClose(clientSocket, 4502, 'container ip unavailable')
    return
  }

  const subprotocolHeader = req.headers['sec-websocket-protocol']
  const subprotocols =
    typeof subprotocolHeader === 'string'
      ? subprotocolHeader.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined

  const upstream = new WebSocket(`ws://${ip}:${parsed.port}${parsed.rest}`, subprotocols, {
    headers: copyForwardableHeaders(req.headers),
  })

  let opened = false

  upstream.on('open', () => {
    opened = true
    bridge(clientSocket, upstream)
  })
  upstream.on('error', (err) => {
    logger.warn({ err, host: `${ip}:${parsed.port}`, rest: parsed.rest }, 'preview ws upstream error')
    if (!opened) safeClose(clientSocket, 4502, 'upstream connection failed')
  })
  upstream.on('unexpected-response', (_upReq, upRes) => {
    logger.warn(
      { status: upRes.statusCode, host: `${ip}:${parsed.port}` },
      'preview ws upstream returned http response',
    )
    safeClose(clientSocket, 4502, `upstream ${upRes.statusCode ?? 'error'}`)
  })

  // If the client closes before upstream opens, abort upstream.
  clientSocket.once('close', () => {
    if (!opened) {
      try {
        upstream.terminate()
      } catch {
        /* ignore */
      }
    }
  })
}

function bridge(a: WebSocket, b: WebSocket): void {
  a.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (b.readyState === WebSocket.OPEN) {
      b.send(data, { binary: isBinary })
    }
  })
  b.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (a.readyState === WebSocket.OPEN) {
      a.send(data, { binary: isBinary })
    }
  })
  const closeBoth = (code = 1000, reason = '') => {
    safeClose(a, code, reason)
    safeClose(b, code, reason)
  }
  a.on('close', (code, reason) => closeBoth(code, reason.toString()))
  b.on('close', (code, reason) => closeBoth(code, reason.toString()))
  a.on('error', () => closeBoth(1011, 'peer error'))
  b.on('error', () => closeBoth(1011, 'peer error'))
  // Forward pings/pongs for keepalive.
  a.on('ping', (d) => {
    try {
      b.ping(d)
    } catch {
      /* ignore */
    }
  })
  b.on('ping', (d) => {
    try {
      a.ping(d)
    } catch {
      /* ignore */
    }
  })
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleHttp(req: any, reply: any): Promise<void> {
  if (!(await isAuthed(req.headers.cookie as string | undefined))) {
    // Top-level browser navigations land on the SPA's login page; XHR/iframe
    // fetches keep the JSON 401 so they can surface a proper error to code.
    const accept = (req.headers.accept as string | undefined) ?? ''
    if (accept.includes('text/html')) {
      reply.redirect('/login', 303)
      return
    }
    reply.code(401).send({ error: 'unauthorized' })
    return
  }
  const parsed = parsePreviewUrl(req.url)
  if (!parsed) {
    reply.code(400).send({ error: 'invalid preview url' })
    return
  }
  const sb = await sandboxManager.get(parsed.sandboxId)
  if (!sb) {
    reply.code(404).send({ error: 'sandbox not found' })
    return
  }
  if (!sb.running || !sb.containerId) {
    reply.code(503).send({ error: 'sandbox not running' })
    return
  }
  const ip = await previewService.getContainerIp(parsed.sandboxId)
  if (!ip) {
    reply.code(502).send({ error: 'container ip unavailable' })
    return
  }

  const upstreamHost = `${ip}:${parsed.port}`
  const outgoingHeaders = filterRequestHeaders(req.headers, upstreamHost)

  const upstreamReq = http.request({
    host: ip,
    port: parsed.port,
    method: req.method,
    path: parsed.rest,
    headers: outgoingHeaders,
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
        logger.warn({ err }, 'preview downstream writeHead failed')
        done()
        return
      }
      upstreamRes.pipe(downstream)
      upstreamRes.on('end', done)
      upstreamRes.on('error', (err) => {
        logger.warn({ err }, 'preview upstream response error')
        try {
          downstream.end()
        } catch {
          /* ignore */
        }
        done()
      })
    })
    upstreamReq.on('error', (err) => {
      logger.warn({ err, host: upstreamHost }, 'preview upstream request error')
      try {
        if (!downstream.headersSent) {
          downstream.writeHead(502, { 'content-type': 'application/json' })
          downstream.end(JSON.stringify({ error: 'bad gateway' }))
        } else {
          downstream.end()
        }
      } catch {
        /* ignore */
      }
      done()
    })

    req.raw.on('error', () => {
      try {
        upstreamReq.destroy()
      } catch {
        /* ignore */
      }
    })
    req.raw.pipe(upstreamReq)
  })
}

function copyForwardableHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'cookie') continue
    if (lower === 'sec-websocket-key') continue
    if (lower === 'sec-websocket-version') continue
    if (lower === 'sec-websocket-extensions') continue
    if (lower === 'sec-websocket-protocol') continue
    if (typeof v === 'string') out[k] = v
    else if (Array.isArray(v)) out[k] = v.join(', ')
  }
  return out
}

