import bcrypt from 'bcrypt'
import { eq, lt, or } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client.js'
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

  const idleCutoff = new Date(now.getTime() - IDLE_TIMEOUT_MS)
  if (row.expiresAt <= now || row.lastSeen <= idleCutoff) {
    await db.delete(webSessions).where(eq(webSessions.id, sessionId))
    return null
  }

  await db.update(webSessions).set({ lastSeen: now }).where(eq(webSessions.id, sessionId))
  return { id: row.id, expiresAt: row.expiresAt, lastSeen: now }
}

export async function createSession(): Promise<Session> {
  const id = ulid()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ABSOLUTE_TTL_MS)
  await db.insert(webSessions).values({ id, createdAt: now, lastSeen: now, expiresAt })
  return { id, expiresAt, lastSeen: now }
}

/**
 * Periodically purge expired and idle-expired sessions. Cheap — one small
 * DELETE per interval.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const now = new Date()
  const idleCutoff = new Date(now.getTime() - IDLE_TIMEOUT_MS)
  const result = await db
    .delete(webSessions)
    .where(or(lt(webSessions.expiresAt, now), lt(webSessions.lastSeen, idleCutoff)))
    .returning({ id: webSessions.id })
  return result.length
}
