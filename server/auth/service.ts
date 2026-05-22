import bcrypt from 'bcrypt'
import { timingSafeEqual } from 'node:crypto'
import { eq, lt, or } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, sqlite } from '../db/client.js'
import { admin, webSessions } from '../db/schema.js'
import { env } from '../env.js'
import { logger } from '../logger.js'
import {
  checkThrottle,
  recordFailure,
  recordSuccess,
  type ThrottleCheck,
} from './throttle.js'

const BCRYPT_COST = 12
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000
export const ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DESKTOP_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000

export class AuthError extends Error {
  constructor(
    public code:
      | 'invalid_password'
      | 'locked'
      | 'backoff'
      | 'already_bootstrapped'
      | 'not_bootstrapped',
    message: string,
    public retryAfterSec?: number,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export interface Session {
  id: string
  expiresAt: Date
  lastSeen: Date
}

async function getAdmin() {
  const rows = await db.select().from(admin).where(eq(admin.id, 1)).limit(1)
  return rows[0] ?? null
}

export async function isBootstrapped(): Promise<boolean> {
  const row = await getAdmin()
  return row !== null
}

export async function seedAdminFromEnv(): Promise<void> {
  const pw = env.ADMIN_PASSWORD_BOOTSTRAP
  if (!pw) return
  if (await isBootstrapped()) {
    logger.info('admin already exists; ignoring ADMIN_PASSWORD_BOOTSTRAP')
    return
  }
  const hash = await bcrypt.hash(pw, BCRYPT_COST)
  await db.insert(admin).values({ id: 1, passwordHash: hash })
  logger.info('admin seeded from ADMIN_PASSWORD_BOOTSTRAP')
}

export async function bootstrap(password: string): Promise<Session> {
  if (await isBootstrapped()) {
    throw new AuthError('already_bootstrapped', 'admin already exists')
  }
  const hash = await bcrypt.hash(password, BCRYPT_COST)
  await db.insert(admin).values({ id: 1, passwordHash: hash })
  return createSession()
}

export async function login(password: string, ip: string): Promise<Session> {
  const check: ThrottleCheck = checkThrottle(ip)
  if (!check.allowed) {
    throw new AuthError(
      check.reason ?? 'locked',
      check.reason === 'locked' ? 'too many failed attempts' : 'slow down',
      check.retryAfterSec,
    )
  }

  const row = await getAdmin()
  if (!row) {
    // Treat "no admin yet" as invalid so we don't leak setup state.
    recordFailure(ip)
    throw new AuthError('not_bootstrapped', 'invalid credentials')
  }

  const ok = await bcrypt.compare(password, row.passwordHash)
  if (!ok) {
    recordFailure(ip)
    throw new AuthError('invalid_password', 'invalid credentials')
  }

  recordSuccess(ip)
  return createSession()
}

export async function logout(sessionId: string): Promise<void> {
  await db.delete(webSessions).where(eq(webSessions.id, sessionId))
}

export async function resolveSession(sessionId: string): Promise<Session | null> {
  const now = new Date()
  const rows = await db.select().from(webSessions).where(eq(webSessions.id, sessionId)).limit(1)
  const row = rows[0]
  if (!row) return null
  const rawSession = readRawSessionDates(row.id)
  const expiresAt = coerceSessionDate(row.expiresAt, rawSession?.expires_at)
  const lastSeen = coerceSessionDate(row.lastSeen, rawSession?.last_seen)

  const idleCutoff = new Date(now.getTime() - IDLE_TIMEOUT_MS)
  if (expiresAt <= now || (!isDesktopAuthEnabled() && lastSeen <= idleCutoff)) {
    await db.delete(webSessions).where(eq(webSessions.id, sessionId))
    return null
  }

  await db.update(webSessions).set({ lastSeen: now }).where(eq(webSessions.id, sessionId))
  return { id: row.id, expiresAt, lastSeen: now }
}

function readRawSessionDates(id: string): { expires_at: unknown; last_seen: unknown } | null {
  return sqlite.prepare('SELECT expires_at, last_seen FROM web_sessions WHERE id = ?').get(id) as { expires_at: unknown; last_seen: unknown } | undefined ?? null
}

function coerceSessionDate(value: Date | number | string, rawValue?: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof rawValue === 'string' && /^\d+(\.\d+)?$/.test(rawValue)) return new Date(Number(rawValue))
  if (typeof rawValue === 'number') return new Date(rawValue)
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return new Date(Number(value))
  return new Date(value)
}

export async function refreshDesktopSession(session: Session): Promise<Session> {
  if (!isDesktopAuthEnabled()) return session
  const now = new Date()
  if (session.expiresAt.getTime() - now.getTime() > DESKTOP_REFRESH_WINDOW_MS) return session

  const expiresAt = new Date(now.getTime() + ABSOLUTE_TTL_MS)
  await db
    .update(webSessions)
    .set({ lastSeen: now, expiresAt })
    .where(eq(webSessions.id, session.id))
  return { id: session.id, lastSeen: now, expiresAt }
}

export async function createSession(): Promise<Session> {
  const id = ulid()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ABSOLUTE_TTL_MS)
  await db.insert(webSessions).values({ id, createdAt: now, lastSeen: now, expiresAt })
  return { id, expiresAt, lastSeen: now }
}

export function isDesktopAuthEnabled(): boolean {
  return Boolean(env.CC_DESKTOP_AUTH_TOKEN)
}

export function verifyDesktopAuthToken(token: string): boolean {
  const expected = env.CC_DESKTOP_AUTH_TOKEN
  if (!expected) return false
  const left = Buffer.from(token)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Periodically purge expired and idle-expired sessions. Cheap — one small
 * DELETE per interval.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const now = new Date()
  if (isDesktopAuthEnabled()) {
    const result = await db.delete(webSessions).where(lt(webSessions.expiresAt, now)).returning({ id: webSessions.id })
    return result.length
  }
  const idleCutoff = new Date(now.getTime() - IDLE_TIMEOUT_MS)
  const result = await db
    .delete(webSessions)
    .where(or(lt(webSessions.expiresAt, now), lt(webSessions.lastSeen, idleCutoff)))
    .returning({ id: webSessions.id })
  return result.length
}
