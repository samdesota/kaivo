import crypto from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { pairSessions } from '../db/schema.js'
import { envMeta } from '../db/schema.js'
import { addEnvTokenHash, hashEnvToken, isPaired, setEnvTokenHash } from '../envmeta/service.js'
import { logger } from '../logger.js'
import { config } from '../config.js'

const PAIR_TTL_MS = 5 * 60 * 1000

export class PairError extends Error {
  constructor(
    public code: 'already_paired' | 'bad_code' | 'expired' | 'not_found',
    message: string,
  ) {
    super(message)
    this.name = 'PairError'
  }
}

function randomDigits(n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += String(crypto.randomInt(0, 10))
  return out
}

function randomSessionId(): string {
  return crypto.randomBytes(16).toString('base64url')
}

function randomEnvToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export interface PairStartResult {
  sessionId: string
  expiresIn: number
}

export function pairStart(): PairStartResult {
  if (isPaired() && config.CC_KIND !== 'local') {
    throw new PairError('already_paired', 'env is already paired')
  }
  // Clean up expired/dangling pair sessions opportunistically.
  db.delete(pairSessions)
    .where(lt(pairSessions.expiresAt, new Date(Date.now()).toISOString()))
    .run()

  const sessionId = randomSessionId()
  const code = randomDigits(6)
  const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString()
  db.insert(pairSessions)
    .values({
      sessionId,
      code,
      createdAt: new Date().toISOString(),
      expiresAt,
    })
    .run()

  // Print on stdout only; the code is NEVER returned from the RPC so that
  // attestation depends on the caller being able to read the local log
  // (launchd / docker logs). Returning it would let anyone who reached
  // this endpoint auto-confirm pairing — defeats the purpose.
  logger.info({ code, sessionId }, 'pair code issued')
  // eslint-disable-next-line no-console
  console.log(`pair code: ${code} (session ${sessionId})`)

  return {
    sessionId,
    expiresIn: Math.floor(PAIR_TTL_MS / 1000),
  }
}

export interface PairConfirmResult {
  envToken: string
}

export function pairConfirm(sessionId: string, code: string): PairConfirmResult {
  const alreadyPaired = isPaired()
  if (alreadyPaired && config.CC_KIND !== 'local') {
    throw new PairError('already_paired', 'env is already paired')
  }
  const rows = db
    .select()
    .from(pairSessions)
    .where(eq(pairSessions.sessionId, sessionId))
    .all()
  const req = rows[0]
  if (!req) throw new PairError('not_found', 'pair session not found')
  if (new Date(req.expiresAt).getTime() < Date.now()) {
    db.delete(pairSessions).where(eq(pairSessions.sessionId, sessionId)).run()
    throw new PairError('expired', 'pair session expired')
  }
  // Constant-time compare on code.
  const a = Buffer.from(req.code)
  const b = Buffer.from(code)
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!ok) throw new PairError('bad_code', 'code did not match')

  const envToken = randomEnvToken()
  const hash = hashEnvToken(envToken)
  if (alreadyPaired) addEnvTokenHash(hash)
  else setEnvTokenHash(hash)
  // Invalidate all pending pair sessions.
  db.delete(pairSessions).run()
  return { envToken }
}

/** CLI helper: reopen pairing. Use when a token is lost and you need to
 * re-pair the same install. Not exposed as an HTTP endpoint. */
export function pairReset(): void {
  db.delete(pairSessions).run()
  db.update(envMeta)
    .set({ envTokenHash: null, pairedAt: null })
    .where(eq(envMeta.id, 1))
    .run()
}
