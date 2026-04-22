import type { FastifyReply } from 'fastify'
import '@fastify/cookie'
import { env, isProd } from '../env.js'
import { ABSOLUTE_TTL_MS } from './service.js'

export const SESSION_COOKIE = 'ccenv_sid'

export function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: env.COOKIE_SECURE ?? isProd,
    // Lax (not Strict) so OAuth-style top-level redirects back to our domain
    // — e.g. GitHub App manifest callback — still carry the session cookie.
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
    maxAge: Math.floor(ABSOLUTE_TTL_MS / 1000),
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  })
}
