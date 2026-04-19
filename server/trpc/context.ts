import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { resolveSession, type Session } from '../auth/service.js'
import { SESSION_COOKIE, clearSessionCookie } from '../auth/cookie.js'

export interface Context {
  req: CreateFastifyContextOptions['req']
  res: CreateFastifyContextOptions['res']
  ip: string
  session: Session | null
}

function clientIp(req: CreateFastifyContextOptions['req']): string {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string' && xf.length > 0) {
    const first = xf.split(',')[0]
    if (first) return first.trim()
  }
  return req.ip || 'unknown'
}

function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    if (k !== name) continue
    return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return null
}

export async function createContext({ req, res }: CreateFastifyContextOptions): Promise<Context> {
  // Fastify populates `req.cookies` for regular HTTP requests. For tRPC
  // subscription upgrades, the trpc adapter hands us a raw IncomingMessage
  // that hasn't passed through fastify's cookie parser — fall back to
  // parsing the Cookie header directly in that case.
  const sid =
    (req as unknown as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE] ??
    parseCookieHeader(req.headers?.cookie as string | undefined, SESSION_COOKIE)
  const session = sid ? await resolveSession(sid) : null
  // If the client sent a cookie but it didn't resolve (session expired,
  // DB wiped, different env) clear it on the response. Otherwise the stale
  // cookie keeps riding along on every request and, combined with SPA auth
  // redirects, can land the user in a redirect loop.
  if (sid && !session && 'setCookie' in (res as object)) {
    try {
      clearSessionCookie(res as unknown as Parameters<typeof clearSessionCookie>[0])
    } catch {
      /* res may be a raw IncomingMessage upgrade — nothing to clear there */
    }
  }
  return { req, res, ip: clientIp(req), session }
}
