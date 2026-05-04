import type { FastifyReply } from 'fastify'
import '@fastify/cookie'
import { env, isProd } from '../env.js'
import { ABSOLUTE_TTL_MS } from './service.js'

const SESSION_COOKIE_BASE = 'ccenv_sid'

export const SESSION_COOKIE = sessionCookieName(env.CC_INSTANCE_ID)

export function sessionCookieName(instanceId: string): string {
  if (env.COOKIE_DOMAIN) return SESSION_COOKIE_BASE
  const suffix = instanceId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return suffix && suffix !== 'default' ? `${SESSION_COOKIE_BASE}_${suffix}` : SESSION_COOKIE_BASE
}

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
