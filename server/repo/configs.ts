import { ulid } from 'ulid'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repoConfigs, repoConfigFiles, type RepoSource } from '../db/schema.js'
import { decryptString, encrypt } from '../secrets/index.js'

export class RepoConfigError extends Error {
  constructor(
    public code:
      | 'not_found'
      | 'name_conflict'
      | 'invalid_url'
      | 'invalid_path'
      | 'path_conflict',
    message: string,
  ) {
    super(message)
    this.name = 'RepoConfigError'
  }
}

const SCP_SSH_URL_RE = /^[a-z_][a-z0-9_-]*@[a-z0-9.-]+:[^\s]+$/i

function isValidUrl(url: string): boolean {
  if (SCP_SSH_URL_RE.test(url)) return true
  try {
    const u = new URL(url)
    return ['https:', 'http:', 'git:', 'ssh:'].includes(u.protocol)
  } catch {
    return false
  }
}

function deriveNameFromUrl(url: string): string {
  if (SCP_SSH_URL_RE.test(url)) {
    const after = url.split(':').slice(1).join(':')
    return (after.split('/').filter(Boolean).pop() || 'repo').replace(/\.git$/, '')
  }
  try {
    const u = new URL(url)
    return (u.pathname.split('/').filter(Boolean).pop() || 'repo').replace(/\.git$/, '')
  } catch {
    return 'repo'
  }
}

/**
 * Reject paths that would escape the repo workspace or trample on .git.
 * Stored paths are workspace-relative (no leading slash, no .. segments).
 */
function validateRelativePath(p: string): string {
  const trimmed = p.trim().replace(/^\/+/, '')
  if (!trimmed) throw new RepoConfigError('invalid_path', 'path is required')
  if (trimmed.length > 1024) throw new RepoConfigError('invalid_path', 'path too long')
  const parts = trimmed.split('/')
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') {
      throw new RepoConfigError('invalid_path', 'path may not contain .. or empty segments')
    }
    if (seg.startsWith('.git')) {
      throw new RepoConfigError('invalid_path', 'path may not write under .git')
    }
  }
  return trimmed
}

export interface RepoConfigSummary {
  id: string
  name: string
  source: RepoSource
  originUrl: string
  ref: string | null
  githubFullName: string | null
  fileCount: number
  createdAt: Date
  updatedAt: Date
}

export interface RepoConfigFileSummary {
  id: string
  configId: string
  path: string
  size: number
  updatedAt: Date
}

class RepoConfigService {
  async list(): Promise<RepoConfigSummary[]> {
    const cfgs = await db.select().from(repoConfigs)
    cfgs.sort((a, b) => a.name.localeCompare(b.name))
    if (cfgs.length === 0) return []
    const files = await db.select().from(repoConfigFiles)
    const counts = new Map<string, number>()
    for (const f of files) counts.set(f.configId, (counts.get(f.configId) ?? 0) + 1)
    return cfgs.map((c) => ({
      id: c.id,
      name: c.name,
      source: c.source,
      originUrl: c.originUrl,
      ref: c.ref,
      githubFullName: c.githubFullName,
      fileCount: counts.get(c.id) ?? 0,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }))
  }

  async get(id: string): Promise<RepoConfigSummary | null> {
    const rows = await db.select().from(repoConfigs).where(eq(repoConfigs.id, id)).limit(1)
    const c = rows[0]
    if (!c) return null
    const files = await db
      .select({ id: repoConfigFiles.id })
      .from(repoConfigFiles)
      .where(eq(repoConfigFiles.configId, id))
    return {
      id: c.id,
      name: c.name,
      source: c.source,
      originUrl: c.originUrl,
      ref: c.ref,
      githubFullName: c.githubFullName,
      fileCount: files.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }
  }

  async create(input: {
    name?: string
    source: RepoSource
    url?: string
    repoFullName?: string
    ref?: string
  }): Promise<RepoConfigSummary> {
    let originUrl: string
    let githubFullName: string | null = null
    let derivedName: string

    if (input.source === 'github') {
      if (!input.repoFullName || !/^[^/\s]+\/[^/\s]+$/.test(input.repoFullName)) {
        throw new RepoConfigError('invalid_url', 'repoFullName must be "owner/name"')
      }
      githubFullName = input.repoFullName
      originUrl = `https://github.com/${input.repoFullName}.git`
      derivedName = input.repoFullName.split('/')[1]!
    } else {
      if (!input.url || !isValidUrl(input.url)) {
        throw new RepoConfigError('invalid_url', 'url must be a valid http(s)/git/ssh URL')
      }
      originUrl = input.url
      derivedName = deriveNameFromUrl(input.url)
    }

    const name = (input.name?.trim() || derivedName).slice(0, 200)
    const exists = await db
      .select({ id: repoConfigs.id })
      .from(repoConfigs)
      .where(eq(repoConfigs.name, name))
      .limit(1)
    if (exists[0]) throw new RepoConfigError('name_conflict', `config "${name}" already exists`)

    const id = ulid().toLowerCase()
    await db.insert(repoConfigs).values({
      id,
      name,
      source: input.source,
      originUrl,
      ref: input.ref?.trim() || null,
      githubFullName,
    })
    return (await this.get(id))!
  }

  async update(id: string, patch: { name?: string; ref?: string | null }): Promise<RepoConfigSummary> {
    const cur = await db.select().from(repoConfigs).where(eq(repoConfigs.id, id)).limit(1)
    if (!cur[0]) throw new RepoConfigError('not_found', 'config not found')
    const updates: Partial<typeof repoConfigs.$inferInsert> = { updatedAt: new Date() }
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 200)
      if (!name) throw new RepoConfigError('invalid_path', 'name required')
      if (name !== cur[0].name) {
        const conflict = await db
          .select({ id: repoConfigs.id })
          .from(repoConfigs)
          .where(eq(repoConfigs.name, name))
          .limit(1)
        if (conflict[0]) throw new RepoConfigError('name_conflict', `config "${name}" already exists`)
      }
      updates.name = name
    }
    if (patch.ref !== undefined) {
      updates.ref = patch.ref?.trim() || null
    }
    await db.update(repoConfigs).set(updates).where(eq(repoConfigs.id, id))
    return (await this.get(id))!
  }

  async remove(id: string): Promise<void> {
    await db.delete(repoConfigs).where(eq(repoConfigs.id, id))
  }

  async listFiles(configId: string): Promise<RepoConfigFileSummary[]> {
    const rows = await db
      .select()
      .from(repoConfigFiles)
      .where(eq(repoConfigFiles.configId, configId))
    rows.sort((a, b) => a.path.localeCompare(b.path))
    // We don't decrypt for the list view; just return path + ciphertext length as a rough size.
    return rows.map((r) => ({
      id: r.id,
      configId: r.configId,
      path: r.path,
      size: Math.floor((r.ciphertext.length * 3) / 4),
      updatedAt: r.updatedAt,
    }))
  }

  /** Returns plaintext for a single file. Used by the editor and by the clone hook. */
  async readFile(configId: string, fileId: string): Promise<{ path: string; contents: string }> {
    const rows = await db
      .select()
      .from(repoConfigFiles)
      .where(and(eq(repoConfigFiles.id, fileId), eq(repoConfigFiles.configId, configId)))
      .limit(1)
    const r = rows[0]
    if (!r) throw new RepoConfigError('not_found', 'file not found')
    const contents = await decryptString({
      ciphertext: r.ciphertext,
      iv: r.iv,
      authTag: r.authTag,
    })
    return { path: r.path, contents }
  }

  async readAllFiles(configId: string): Promise<Array<{ path: string; contents: string }>> {
    const rows = await db
      .select()
      .from(repoConfigFiles)
      .where(eq(repoConfigFiles.configId, configId))
    const out: Array<{ path: string; contents: string }> = []
    for (const r of rows) {
      const contents = await decryptString({
        ciphertext: r.ciphertext,
        iv: r.iv,
        authTag: r.authTag,
      })
      out.push({ path: r.path, contents })
    }
    return out
  }

  async putFile(opts: {
    configId: string
    fileId?: string
    path: string
    contents: string
  }): Promise<RepoConfigFileSummary> {
    const cfg = await db
      .select({ id: repoConfigs.id })
      .from(repoConfigs)
      .where(eq(repoConfigs.id, opts.configId))
      .limit(1)
    if (!cfg[0]) throw new RepoConfigError('not_found', 'config not found')

    const path = validateRelativePath(opts.path)
    const enc = await encrypt(opts.contents)

    if (opts.fileId) {
      const existing = await db
        .select()
        .from(repoConfigFiles)
        .where(
          and(eq(repoConfigFiles.id, opts.fileId), eq(repoConfigFiles.configId, opts.configId)),
        )
        .limit(1)
      if (!existing[0]) throw new RepoConfigError('not_found', 'file not found')
      // If renaming, ensure no path collision with another file in this config.
      if (existing[0].path !== path) {
        const conflict = await db
          .select({ id: repoConfigFiles.id })
          .from(repoConfigFiles)
          .where(and(eq(repoConfigFiles.configId, opts.configId), eq(repoConfigFiles.path, path)))
          .limit(1)
        if (conflict[0]) throw new RepoConfigError('path_conflict', `file "${path}" already exists`)
      }
      await db
        .update(repoConfigFiles)
        .set({
          path,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
          updatedAt: new Date(),
        })
        .where(eq(repoConfigFiles.id, opts.fileId))
      await db.update(repoConfigs).set({ updatedAt: new Date() }).where(eq(repoConfigs.id, opts.configId))
      return {
        id: opts.fileId,
        configId: opts.configId,
        path,
        size: opts.contents.length,
        updatedAt: new Date(),
      }
    }

    // Create
    const conflict = await db
      .select({ id: repoConfigFiles.id })
      .from(repoConfigFiles)
      .where(and(eq(repoConfigFiles.configId, opts.configId), eq(repoConfigFiles.path, path)))
      .limit(1)
    if (conflict[0]) throw new RepoConfigError('path_conflict', `file "${path}" already exists`)

    const id = ulid().toLowerCase()
    await db.insert(repoConfigFiles).values({
      id,
      configId: opts.configId,
      path,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
    })
    await db.update(repoConfigs).set({ updatedAt: new Date() }).where(eq(repoConfigs.id, opts.configId))
    return { id, configId: opts.configId, path, size: opts.contents.length, updatedAt: new Date() }
  }

  async removeFile(configId: string, fileId: string): Promise<void> {
    await db
      .delete(repoConfigFiles)
      .where(and(eq(repoConfigFiles.id, fileId), eq(repoConfigFiles.configId, configId)))
  }
}

export const repoConfigService = new RepoConfigService()
