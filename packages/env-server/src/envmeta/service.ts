import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { envMeta, envTokens } from '../db/schema.js'
import { logger } from '../logger.js'

export interface Secrets {
  envToken?: string
  identityToken?: string
}

const secretsPath = path.join(config.CC_STATE_DIR, 'secrets.json')

export function hashEnvToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export async function readSecrets(): Promise<Secrets> {
  try {
    const txt = await fs.readFile(secretsPath, 'utf8')
    return JSON.parse(txt) as Secrets
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

export async function writeSecrets(s: Secrets): Promise<void> {
  await fs.mkdir(path.dirname(secretsPath), { recursive: true })
  const tmp = `${secretsPath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 })
  await fs.rename(tmp, secretsPath)
}

async function ensureRow(): Promise<void> {
  const rows = db.select().from(envMeta).where(eq(envMeta.id, 1)).all()
  if (rows.length === 0) {
    db.insert(envMeta).values({ id: 1 }).run()
  }
}

export interface EnvMetaRow {
  envTokenHash: string | null
  pairedAt: string | null
  opencodePort: number | null
  opencodePasswordHash: string | null
  defaultProviderId: string | null
  defaultModelId: string | null
}

export function getMeta(): EnvMetaRow {
  const rows = db.select().from(envMeta).where(eq(envMeta.id, 1)).all()
  const r = rows[0]
  if (!r) {
    return {
      envTokenHash: null,
      pairedAt: null,
      opencodePort: null,
      opencodePasswordHash: null,
      defaultProviderId: null,
      defaultModelId: null,
    }
  }
  return {
    envTokenHash: r.envTokenHash,
    pairedAt: r.pairedAt,
    opencodePort: r.opencodePort,
    opencodePasswordHash: r.opencodePasswordHash,
    defaultProviderId: r.defaultProviderId,
    defaultModelId: r.defaultModelId,
  }
}

export function setEnvTokenHash(hash: string): void {
  db.update(envMeta)
    .set({ envTokenHash: hash, pairedAt: new Date().toISOString() })
    .where(eq(envMeta.id, 1))
    .run()
}

export function addEnvTokenHash(hash: string): void {
  db.insert(envTokens)
    .values({
      id: crypto.randomBytes(16).toString('base64url'),
      tokenHash: hash,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run()
}

export function hasEnvTokenHash(hash: string): boolean {
  if (getMeta().envTokenHash === hash) return true
  return (
    db.select({ id: envTokens.id }).from(envTokens).where(eq(envTokens.tokenHash, hash)).all()
      .length > 0
  )
}

export function setOpencodePort(port: number): void {
  db.update(envMeta).set({ opencodePort: port }).where(eq(envMeta.id, 1)).run()
}

export function setOpencodePasswordHash(hash: string): void {
  db.update(envMeta).set({ opencodePasswordHash: hash }).where(eq(envMeta.id, 1)).run()
}

export function setDefaultModel(providerID: string, modelID: string): void {
  db.update(envMeta)
    .set({ defaultProviderId: providerID, defaultModelId: modelID })
    .where(eq(envMeta.id, 1))
    .run()
}

/**
 * Boot init: ensure the single env_meta row exists. If secrets.json has
 * an envToken (container mode with the orchestrator having pre-seeded it),
 * hash it into env_meta on first boot and strip it from the file so it
 * doesn't sit at rest longer than needed.
 */
export async function initEnvMetaFromSecrets(): Promise<void> {
  await ensureRow()
  const current = getMeta()
  const secrets = await readSecrets()
  if (secrets.envToken && !current.envTokenHash) {
    setEnvTokenHash(hashEnvToken(secrets.envToken))
    const { envToken: _dropped, ...rest } = secrets
    await writeSecrets(rest)
    logger.info('env token adopted from secrets.json')
  }
}

export function isPaired(): boolean {
  return getMeta().envTokenHash !== null
}
