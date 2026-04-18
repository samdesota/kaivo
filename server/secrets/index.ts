import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { secrets } from '../db/schema.js'
import { env } from '../env.js'

const KEY_BYTES = 32 // AES-256
const IV_BYTES = 12 // GCM
const TAG_BYTES = 16

let masterKey: Buffer | null = null

export async function loadMasterKey(): Promise<Buffer> {
  if (masterKey) return masterKey

  await fs.mkdir(env.DATA_DIR, { recursive: true })
  const keyPath = path.join(env.DATA_DIR, 'secrets.key')

  try {
    const stat = await fs.stat(keyPath)
    if (!stat.isFile()) {
      throw new Error(`secrets.key at ${keyPath} is not a regular file`)
    }
    const raw = await fs.readFile(keyPath)
    if (raw.length !== KEY_BYTES) {
      throw new Error(`secrets.key has invalid length ${raw.length} (expected ${KEY_BYTES})`)
    }
    masterKey = raw
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const fresh = crypto.randomBytes(KEY_BYTES)
    // Atomic-ish: write to tmp + rename; then chmod 0600.
    const tmp = keyPath + '.tmp'
    await fs.writeFile(tmp, fresh, { mode: 0o600 })
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, keyPath)
    masterKey = fresh
  }

  return masterKey
}

export interface EncryptedPayload {
  ciphertext: string
  iv: string
  authTag: string
}

export async function encrypt(plaintext: string | Buffer): Promise<EncryptedPayload> {
  const key = await loadMasterKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext
  const ct = Buffer.concat([cipher.update(input), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: tag.toString('base64'),
  }
}

export async function decrypt(payload: EncryptedPayload): Promise<Buffer> {
  const key = await loadMasterKey()
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.authTag, 'base64')
  if (tag.length !== TAG_BYTES) {
    throw new Error(`invalid auth tag length ${tag.length}`)
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const ct = Buffer.from(payload.ciphertext, 'base64')
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

export async function decryptString(payload: EncryptedPayload): Promise<string> {
  return (await decrypt(payload)).toString('utf8')
}

/**
 * Named-secret storage backed by the `secrets` table. Use for things like the
 * GitHub App private key and per-sandbox OpenCode passwords (later phases).
 */
export async function putSecret(name: string, value: string): Promise<void> {
  const enc = await encrypt(value)
  await db
    .insert(secrets)
    .values({ name, ...enc })
    .onConflictDoUpdate({
      target: secrets.name,
      set: { ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag },
    })
}

export async function getSecret(name: string): Promise<string | null> {
  const rows = await db.select().from(secrets).where(eq(secrets.name, name)).limit(1)
  if (rows.length === 0) return null
  const row = rows[0]!
  return decryptString({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag })
}

// Test helper.
export function __resetMasterKeyForTests(): void {
  masterKey = null
}
