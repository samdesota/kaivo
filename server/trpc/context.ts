import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { resolveSession, type Session } from '../auth/service.js'
import { SESSION_COOKIE } from '../auth/cookie.js'

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

export async function createContext({ req, res }: CreateFastifyContextOptions): Promise<Context> {
  const sid = (req as unknown as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE]
  const session = sid ? await resolveSession(sid) : null
  return { req, res, ip: clientIp(req), session }
}
