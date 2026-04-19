import http from 'node:http'
import { WebSocket } from 'ws'
import { logger } from '../logger.js'
import { resolveSession } from '../auth/service.js'
import { SESSION_COOKIE } from '../auth/cookie.js'
import { sandboxManager } from '../sandbox/manager.js'
import { opencodeBasicAuthHeader, resolveEndpoint } from './opencode.js'

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

const AGENT_PREFIX = '/sandbox/'
const AGENT_SEG = '/agent'

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
 * `/sandbox/<id>/agent/<rest?>` — strip the `/sandbox/<id>/agent` prefix and
 * forward the remaining path (including query string) upstream. Returns null
 * for anything that isn't an agent route.
 */
export function parseAgentUrl(
  url: string,
): { sandboxId: string; rest: string } | null {
  if (!url.startsWith(AGENT_PREFIX)) return null
  const qIdx = url.indexOf('?')
  const pathOnly = qIdx < 0 ? url : url.slice(0, qIdx)
  const query = qIdx < 0 ? '' : url.slice(qIdx)

  // pathOnly: /sandbox/<id>/agent[/<rest>]
  const rest = pathOnly.slice(AGENT_PREFIX.length) // <id>/agent[/<rest>]
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const sandboxId = rest.slice(0, slash)
  const afterSandbox = rest.slice(slash) // /agent[/<rest>]
  if (!afterSandbox.startsWith(AGENT_SEG)) return null
  const afterSeg = afterSandbox.slice(AGENT_SEG.length) // '' | '/...'
  if (afterSeg !== '' && !afterSeg.startsWith('/')) return null
  const tail = afterSeg === '' ? '/' : afterSeg
  if (!sandboxId) return null
  return { sandboxId, rest: tail + query }
}

/**
 * OpenCode's web UI is a Vite-built SPA with absolute asset paths
 * (`<script src="/assets/index-*.js">`). When the iframe loads those,
 * the browser requests them against our origin — not via our agent
 * prefix — and they fall through to the SPA fallback, which returns
 * `index.html` with the wrong MIME type.
 *
 * To rescue those requests, look at the `Referer`: if it points at
 * `/sandbox/<id>/agent/...`, the requesting document is the iframe, so
 * proxy the request to that sandbox's OpenCode using the original URL
 * as the upstream path.
 *
 * We only claim paths the main app doesn't own — letting `/trpc`,
 * `/preview/`, `/api/`, `/ws/shell`, `/healthz`, and other `/sandbox/*`
 * routes keep their normal handling.
 */
const RESERVED_PREFIXES = [
  '/trpc',
  '/preview/',
  '/api/',
  '/ws/',
  '/healthz',
  '/sandbox/',
  '/agent/',
  '/.well-known/',
  // Main-app SPA assets. OpenCode's own /assets/* requests from the iframe
  // are always rewritten by the proxy to the prefixed /sandbox/<id>/agent/
  // form, so they hit the direct-match path — never rescue.
  '/assets/',
  '/@vite/',
  '/favicon',
  '/robots.txt',
]

const AGENT_COOKIE = 'ccenv_agent_sandbox'

export function parseAgentReferer(
  urlPath: string,
  referer: string | undefined,
): { sandboxId: string; rest: string } | null {
  if (!referer) return null
  for (const p of RESERVED_PREFIXES) {
    if (urlPath.startsWith(p)) return null
  }
  let refUrl: URL
  try {
    refUrl = new URL(referer)
  } catch {
    return null
  }
  const m = refUrl.pathname.match(/^\/sandbox\/([^/]+)\/agent(?:\/|$)/)
  if (!m) return null
  return { sandboxId: m[1]!, rest: urlPath }
}

/**
 * Cookie-based rescue. OpenCode's web UI does client-side routing
 * (pushState) that rewrites the iframe URL out from under our
 * `/sandbox/<id>/agent/` prefix — so after the first navigation, Referer
 * no longer carries the sandbox id. When the iframe's initial document
 * request is served by the direct-match path, we stamp
 * `ccenv_agent_sandbox=<id>` on the response so subsequent fetches can
 * still be routed, regardless of what Referer says.
 *
 * v1 limitation: cookie is per-origin, not per-tab. Opening two agent
 * iframes for different sandboxes causes the last-loaded to win; the
 * other tab's fetches will be routed to the wrong sandbox. Acceptable
 * for single-admin deployments.
 */
export function parseAgentCookie(
  urlPath: string,
  cookieHeader: string | undefined,
): { sandboxId: string; rest: string } | null {
  if (!cookieHeader) return null
  for (const p of RESERVED_PREFIXES) {
    if (urlPath.startsWith(p)) return null
  }
  const sandboxId = parseCookieHeader(cookieHeader, AGENT_COOKIE)
  if (!sandboxId) return null
  return { sandboxId, rest: urlPath }
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
    if (lower === 'cookie') continue
    if (lower === 'authorization') continue
    if (lower === 'accept-encoding') continue
    if (v !== undefined) out[k] = v as string | string[]
  }
  out.host = upstreamHost
  // OpenCode's serve uses HTTP Basic auth (user=`opencode`) when
  // OPENCODE_SERVER_PASSWORD is set — inject here so the embedded iframe
  // never prompts for a second login.
  out.authorization = opencodeBasicAuthHeader(password)
  // Force uncompressed responses so we can rewrite asset paths without
  // decoding gzip/br. The OpenCode dev UI is tiny; the cost is negligible.
  out['accept-encoding'] = 'identity'
  return out
}

const REWRITE_CONTENT_TYPES = [
  'text/html',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'text/css',
]

function shouldRewriteBody(contentType: string | undefined): boolean {
  if (!contentType) return false
  const lower = contentType.toLowerCase()
  return REWRITE_CONTENT_TYPES.some((t) => lower.startsWith(t))
}

/**
 * Rewrite absolute `/assets/*` references to the prefixed path. Needed
 * because OpenCode's web UI is a Vite build with `base: "/"`, so its
 * static HTML and bundled JS emit absolute paths like
 * `"/assets/index-abc.js"` — including dynamically-imported chunks,
 * whose `Referer` is the importing module, not the iframe document.
 *
 * Lookbehind guards against rewriting inside fully-qualified URLs
 * (e.g. `https://cdn.example.com/assets/...`). Anything already at
 * a prefixed path is idempotent under this pass.
 */
export function rewriteAssetPaths(body: string, sandboxId: string): string {
  return body.replace(
    /(?<![\w/:])\/assets\//g,
    `/sandbox/${sandboxId}/agent/assets/`,
  )
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
 * Register the agent UI reverse proxy. Same dance as the preview proxy:
 * HTTP via onRequest hook, WS via a Fastify websocket route (because
 * @fastify/websocket installs its own upgrade listener).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAgentProxy(server: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.addHook('onRequest', async (req: any, reply: any) => {
    if ((req.headers.upgrade ?? '').toString().toLowerCase() === 'websocket') return
    const direct = parseAgentUrl(req.url)
    if (direct) {
      await handleHttp(req, reply, direct, { setCookie: true })
      return
    }
    const qIdx = req.url.indexOf('?')
    const urlPath = qIdx < 0 ? req.url : req.url.slice(0, qIdx)
    // 1) Referer rescue — works until OpenCode's client-side router pushes
    //    state off the `/sandbox/<id>/agent/` prefix.
    const refered = parseAgentReferer(urlPath, req.headers.referer as string | undefined)
    if (refered) {
      await handleHttp(req, reply, { sandboxId: refered.sandboxId, rest: req.url })
      return
    }
    // 2) Cookie rescue — keeps routing alive after client-side nav.
    const cookied = parseAgentCookie(urlPath, req.headers.cookie as string | undefined)
    if (cookied) {
      await handleHttp(req, reply, { sandboxId: cookied.sandboxId, rest: req.url })
    }
  })

  // Direct-mode WS routes.
  for (const path of ['/sandbox/:sandboxId/agent', '/sandbox/:sandboxId/agent/*']) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.get(path, { websocket: true }, async (clientSocket: any, req: any) => {
      const parsed = parseAgentUrl(req.url as string)
      if (!parsed) {
        safeClose(clientSocket, 4400, 'invalid agent url')
        return
      }
      await handleWs(clientSocket, req, parsed)
    })
  }
}

async function handleHttp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reply: any,
  parsed: { sandboxId: string; rest: string },
  opts: { setCookie?: boolean } = {},
): Promise<void> {
  if (!(await isAuthed(req.headers.cookie as string | undefined))) {
    // Redirect browser top-level navigations to the SPA's login page so the
    // user sees a login screen instead of raw JSON. XHR/iframe callers still
    // get the machine-readable 401.
    const accept = (req.headers.accept as string | undefined) ?? ''
    if (accept.includes('text/html')) {
      reply.redirect('/login', 303)
      return
    }
    reply.code(401).send({ error: 'unauthorized' })
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
  const ep = await resolveEndpoint(parsed.sandboxId)
  if (!ep) {
    reply.code(502).send({ error: 'agent endpoint unavailable' })
    return
  }

  const upstreamHost = `${ep.ip}:${ep.port}`
  const outgoingHeaders = filterRequestHeaders(req.headers, upstreamHost, ep.password)

  const upstreamReq = http.request({
    host: ep.ip,
    port: ep.port,
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
      if (opts.setCookie) {
        const existing = headers['set-cookie']
        const cookie = `${AGENT_COOKIE}=${parsed.sandboxId}; Path=/; SameSite=Lax`
        headers['set-cookie'] = existing
          ? Array.isArray(existing)
            ? [...existing, cookie]
            : [existing as string, cookie]
          : cookie
      }
      const rewrite = shouldRewriteBody(upstreamRes.headers['content-type'] as string | undefined)

      if (rewrite) {
        const chunks: Buffer[] = []
        upstreamRes.on('data', (c) => chunks.push(Buffer.from(c)))
        upstreamRes.on('end', () => {
          const body = rewriteAssetPaths(
            Buffer.concat(chunks).toString('utf8'),
            parsed.sandboxId,
          )
          const buf = Buffer.from(body, 'utf8')
          // Rewriting changes length, so drop the upstream value.
          delete headers['content-length']
          headers['content-length'] = String(buf.length)
          try {
            downstream.writeHead(upstreamRes.statusCode ?? 502, headers)
            downstream.end(buf)
          } catch (err) {
            logger.warn({ err }, 'agent proxy rewrite write failed')
          }
          done()
        })
        upstreamRes.on('error', (err) => {
          logger.warn({ err }, 'agent proxy upstream response error')
          try {
            downstream.end()
          } catch {
            /* ignore */
          }
          done()
        })
        return
      }

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
        logger.warn({ err }, 'agent proxy upstream response error')
        try {
          downstream.end()
        } catch {
          /* ignore */
        }
        done()
      })
    })
    upstreamReq.on('error', (err) => {
      logger.warn({ err, host: upstreamHost }, 'agent proxy upstream error')
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

async function handleWs(
  clientSocket: WebSocket,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: any,
  parsed: { sandboxId: string; rest: string },
): Promise<void> {
  if (!(await isAuthed(req.headers.cookie as string | undefined))) {
    safeClose(clientSocket, 4401, 'unauthorized')
    return
  }
  const sb = await sandboxManager.get(parsed.sandboxId)
  if (!sb || !sb.running || !sb.containerId) {
    safeClose(clientSocket, 4503, 'sandbox not running')
    return
  }
  const ep = await resolveEndpoint(parsed.sandboxId)
  if (!ep) {
    safeClose(clientSocket, 4502, 'agent endpoint unavailable')
    return
  }

  const subprotocolHeader = req.headers['sec-websocket-protocol']
  const subprotocols =
    typeof subprotocolHeader === 'string'
      ? subprotocolHeader.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined

  const upstream = new WebSocket(
    `ws://${ep.ip}:${ep.port}${parsed.rest}`,
    subprotocols,
    { headers: { authorization: opencodeBasicAuthHeader(ep.password) } },
  )

  let opened = false
  upstream.on('open', () => {
    opened = true
    bridge(clientSocket, upstream)
  })
  upstream.on('error', (err) => {
    logger.warn({ err, host: `${ep.ip}:${ep.port}`, rest: parsed.rest }, 'agent ws upstream error')
    if (!opened) safeClose(clientSocket, 4502, 'upstream connection failed')
  })
  upstream.on('unexpected-response', (_upReq, upRes) => {
    safeClose(clientSocket, 4502, `upstream ${upRes.statusCode ?? 'error'}`)
  })
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
    if (b.readyState === WebSocket.OPEN) b.send(data, { binary: isBinary })
  })
  b.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
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
