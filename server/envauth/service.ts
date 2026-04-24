import crypto from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { envAuthDeviceRequests, envAuthTokens } from '../db/schema.js'
import type { EnvAuthTokenSource } from '../db/schema.js'
import { logger } from '../logger.js'

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const USER_CODE_LEN = 8

function randomOpaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function randomUserCode(): string {
  // 8 chars of unambiguous alphabet, hyphenated as XXXX-XXXX for readability.
  let out = ''
  for (let i = 0; i < USER_CODE_LEN; i++) {
    out += USER_CODE_ALPHABET[crypto.randomInt(0, USER_CODE_ALPHABET.length)]
    if (i === 3) out += '-'
  }
  return out
}

function randomDeviceCode(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/**
 * Raw identity tokens are kept in memory between deviceConfirm and the
 * first devicePoll. Storing them in the DB would duplicate the hash we
 * already persist and expand the blast radius of a table-level read.
 * A server restart drops in-flight pairings; callers are expected to
 * retry the device flow if that happens (TTL is 10 minutes).
 */
const pendingDeviceTokens = new Map<string, string>()

export async function issueEnvAuthToken(
  label: string,
  source: EnvAuthTokenSource,
): Promise<{ token: string; tokenHash: string }> {
  const token = randomOpaqueToken()
  const tokenHash = hashToken(token)
  await db.insert(envAuthTokens).values({ tokenHash, label, source })
  return { token, tokenHash }
}

export interface ResolvedEnvAuth {
  tokenHash: string
  label: string
  source: EnvAuthTokenSource
}

/**
 * Look up a presented bearer token. Returns null for unknown, revoked, or
 * bad-shape input. Constant-time at the hash level (SHA-256 of the input is
 * used as the PK lookup; there is no user-controlled string compare).
 */
export async function resolveEnvAuthToken(raw: string): Promise<ResolvedEnvAuth | null> {
  if (!raw || raw.length < 8) return null
  const tokenHash = hashToken(raw)
  const rows = await db
    .select()
    .from(envAuthTokens)
    .where(eq(envAuthTokens.tokenHash, tokenHash))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  if (row.revokedAt) return null
  return { tokenHash: row.tokenHash, label: row.label, source: row.source }
}

export async function revokeEnvAuthToken(tokenHash: string): Promise<void> {
  await db
    .update(envAuthTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(envAuthTokens.tokenHash, tokenHash), /* only-once */ eq(envAuthTokens.tokenHash, tokenHash)))
}

export interface DeviceStartResult {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresIn: number
}

export async function deviceStart(
  label: string,
  baseUrl: string,
): Promise<DeviceStartResult> {
  const deviceCode = randomDeviceCode()
  const userCode = randomUserCode()
  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS)
  await db.insert(envAuthDeviceRequests).values({
    deviceCode,
    userCode,
    label,
    expiresAt,
  })
  const trimmed = baseUrl.replace(/\/+$/, '')
  const verificationUrl = `${trimmed}/envauth/device?code=${encodeURIComponent(userCode)}`
  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
  }
}

export class DeviceAuthError extends Error {
  constructor(
    public readonly kind: 'not_found' | 'expired' | 'already_resolved',
    message: string,
  ) {
    super(message)
    this.name = 'DeviceAuthError'
  }
}

export async function deviceConfirm(userCode: string): Promise<void> {
  const normalized = userCode.trim().toUpperCase()
  const rows = await db
    .select()
    .from(envAuthDeviceRequests)
    .where(eq(envAuthDeviceRequests.userCode, normalized))
    .limit(1)
  const req = rows[0]
  if (!req) throw new DeviceAuthError('not_found', 'code not recognized')
  if (req.expiresAt.getTime() < Date.now()) {
    await db
      .update(envAuthDeviceRequests)
      .set({ status: 'expired' })
      .where(eq(envAuthDeviceRequests.deviceCode, req.deviceCode))
    throw new DeviceAuthError('expired', 'code has expired — restart install.sh')
  }
  if (req.status !== 'pending') {
    throw new DeviceAuthError('already_resolved', `code already ${req.status}`)
  }
  const { token, tokenHash } = await issueEnvAuthToken(req.label, 'device')
  await db
    .update(envAuthDeviceRequests)
    .set({ status: 'approved', approvedAt: new Date(), grantedTokenHash: tokenHash })
    .where(eq(envAuthDeviceRequests.deviceCode, req.deviceCode))
  pendingDeviceTokens.set(req.deviceCode, token)
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; identityToken: string }

export async function devicePoll(deviceCode: string): Promise<DevicePollResult> {
  const rows = await db
    .select()
    .from(envAuthDeviceRequests)
    .where(eq(envAuthDeviceRequests.deviceCode, deviceCode))
    .limit(1)
  const req = rows[0]
  if (!req) return { status: 'expired' }
  if (req.status === 'pending' && req.expiresAt.getTime() < Date.now()) {
    await db
      .update(envAuthDeviceRequests)
      .set({ status: 'expired' })
      .where(eq(envAuthDeviceRequests.deviceCode, deviceCode))
    return { status: 'expired' }
  }
  if (req.status === 'approved') {
    const raw = pendingDeviceTokens.get(deviceCode)
    if (!raw) {
      // Already consumed or server restarted. The token still exists in the
      // DB, but we can't return its raw form — require a fresh device flow.
      return { status: 'expired' }
    }
    pendingDeviceTokens.delete(deviceCode)
    return { status: 'approved', identityToken: raw }
  }
  if (req.status === 'denied' || req.status === 'expired') {
    return { status: req.status }
  }
  return { status: 'pending' }
}

/** Cheap periodic cleanup. Safe to run on a timer or at boot. */
export async function gcExpiredDeviceRequests(): Promise<number> {
  const res = await db
    .update(envAuthDeviceRequests)
    .set({ status: 'expired' })
    .where(
      and(
        eq(envAuthDeviceRequests.status, 'pending'),
        lt(envAuthDeviceRequests.expiresAt, new Date()),
      ),
    )
  const count = (res as { rowCount?: number }).rowCount ?? 0
  if (count > 0) logger.info({ count }, 'expired device requests')
  return count
}
