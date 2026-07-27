import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { repos } from '../db/schema.js'
import { getRepoConfig, listRepoConfigs, type RepoConfigSummary } from '../identity/client.js'

export class RepoError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_config' | 'already_exists' | 'ref_not_found' | 'branch_conflict' | 'clone_failed' | 'delete_failed',
    message: string,
    public readonly residualArtifacts: string[] = [],
  ) {
    super(message)
    this.name = 'RepoError'
  }
}

export interface RepoCloneResult {
  configId: string
  repoId: string
  workingDir: string
  name: string
  worktreeName: string
}

export interface RepoExactRefCloneResult extends RepoCloneResult {
  sourceRef: string
  branchName: string
  resolvedCommit: string
}

export interface RepoWorktreeSummary {
  id: string
  configId: string | null
  name: string
  slug: string
  worktreeName: string
  worktreeSlug: string
  originUrl: string
  ref: string
  workingDir: string
  githubFullName: string | null
  createdAt: string
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'repo'
}

function repoUrl(summary: RepoConfigSummary): string {
  if (summary.originUrl) return summary.originUrl
  if (summary.githubFullName) return `https://github.com/${summary.githubFullName}.git`
  throw new RepoError('invalid_config', 'repo config is missing an origin URL')
}

function safeJoin(root: string, relativePath: string): string {
  const clean = relativePath.replace(/^[/\\]+/, '')
  const full = path.resolve(root, clean)
  const rootResolved = path.resolve(root)
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new RepoError('invalid_config', `repo config file escapes clone: ${relativePath}`)
  }
  return full
}

function runGitClone(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => reject(new RepoError('clone_failed', err.message)))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new RepoError('clone_failed', stderr.trim() || `git clone exited ${code}`))
    })
  })
}

function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (err) => reject(new RepoError('clone_failed', err.message)))
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new RepoError('clone_failed', stderr.trim() || `git ${args[0] ?? ''} exited ${code}`))
    })
  })
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function refCandidates(sourceRef: string): string[] {
  if (sourceRef.startsWith('refs/heads/')) {
    return [`refs/remotes/origin/${sourceRef.slice('refs/heads/'.length)}^{commit}`]
  }
  if (sourceRef.startsWith('refs/tags/') || sourceRef.startsWith('refs/remotes/')) {
    return [`${sourceRef}^{commit}`]
  }
  return [
    `refs/remotes/origin/${sourceRef}^{commit}`,
    `refs/tags/${sourceRef}^{commit}`,
    `${sourceRef}^{commit}`,
  ]
}

class RepoService {
  async listConfigs(): Promise<RepoConfigSummary[]> {
    return listRepoConfigs()
  }

  listWorktrees(): RepoWorktreeSummary[] {
    return db.select().from(repos).all().map((row) => ({
      id: row.id,
      configId: row.configId,
      name: row.name,
      slug: row.slug,
      worktreeName: row.worktreeName ?? path.basename(row.workspacePath),
      worktreeSlug: row.worktreeSlug ?? path.basename(row.workspacePath),
      originUrl: row.originUrl,
      ref: row.ref,
      workingDir: row.workspacePath,
      githubFullName: row.githubFullName,
      createdAt: row.createdAt,
    }))
  }

  async cloneConfig(configId: string, worktreeName: string): Promise<RepoCloneResult> {
    let bundle: Awaited<ReturnType<typeof getRepoConfig>>
    try {
      bundle = await getRepoConfig(configId)
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? ''
      if (/not_found|not found|404/i.test(msg)) {
        throw new RepoError('not_found', 'repo config not found')
      }
      throw err
    }

    const cloneRoot = path.join(config.CC_WORKING_DIR, 'repos')
    const slug = slugify(bundle.summary.name)
    if (!worktreeName.trim()) throw new RepoError('invalid_config', 'work tree name is required')
    const worktreeSlug = slugify(worktreeName)
    const repoRoot = path.join(cloneRoot, slug)
    const workingDir = path.join(repoRoot, worktreeSlug)
    await fs.mkdir(repoRoot, { recursive: true })

    try {
      await fs.stat(workingDir)
      throw new RepoError('already_exists', `work tree already exists: ${slug}/${worktreeSlug}`)
    } catch (err) {
      if (err instanceof RepoError) throw err
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    const args = ['clone', '--progress']
    if (bundle.summary.ref) args.push('--branch', bundle.summary.ref)
    const originUrl = repoUrl(bundle.summary)
    args.push(originUrl, workingDir)
    try {
      await runGitClone(args)
    } catch (err) {
      await fs.rm(workingDir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }

    for (const file of bundle.files) {
      const target = safeJoin(workingDir, file.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, file.contents, 'utf8')
    }

    const repoId = ulid()
    db.insert(repos).values({
      id: repoId,
      configId,
      name: bundle.summary.name,
      slug,
      worktreeName,
      worktreeSlug,
      originUrl,
      ref: bundle.summary.ref ?? '',
      workspacePath: workingDir,
      source: bundle.summary.source ?? (bundle.summary.githubFullName ? 'github' : 'url'),
      githubRepoId: null,
      githubFullName: bundle.summary.githubFullName ?? null,
      createdAt: new Date().toISOString(),
    }).run()

    return { configId, repoId, workingDir, name: bundle.summary.name, worktreeName }
  }

  async cloneConfigAtRef(input: {
    configId: string
    workspaceId: string
    worktreeName: string
    sourceRef: string
    branchName: string
  }): Promise<RepoExactRefCloneResult> {
    const worktreeName = input.worktreeName.trim()
    const sourceRef = input.sourceRef.trim()
    const branchName = input.branchName.trim()
    if (!worktreeName || !sourceRef || !branchName) {
      throw new RepoError('invalid_config', 'work tree name, source ref, and branch are required')
    }
    try {
      await runGit(['check-ref-format', '--branch', branchName])
    } catch {
      throw new RepoError('invalid_config', `invalid branch name: ${branchName}`)
    }

    let bundle: Awaited<ReturnType<typeof getRepoConfig>>
    try {
      bundle = await getRepoConfig(input.configId)
    } catch (err) {
      const message = (err as { message?: string })?.message ?? ''
      if (/not_found|not found|404/i.test(message)) throw new RepoError('not_found', 'repo config not found')
      throw err
    }

    const slug = slugify(bundle.summary.name)
    const worktreeSlug = slugify(worktreeName)
    const repoRoot = path.join(config.CC_WORKING_DIR, 'repos', slug)
    const workingDir = path.join(repoRoot, worktreeSlug)
    await fs.mkdir(repoRoot, { recursive: true })
    if (await pathExists(workingDir)) {
      throw new RepoError('already_exists', `work tree already exists: ${slug}/${worktreeSlug}`)
    }

    const originUrl = repoUrl(bundle.summary)
    let createdClone = false
    let repoId: string | null = null
    try {
      await runGit(['clone', '--no-checkout', '--origin', 'origin', originUrl, workingDir])
      createdClone = true

      let resolvedCommit: string | null = null
      for (const candidate of refCandidates(sourceRef)) {
        try {
          resolvedCommit = await runGit(['rev-parse', '--verify', candidate], workingDir)
          break
        } catch {
          // Try the next exact namespace; never use the configured default ref.
        }
      }
      if (!resolvedCommit) throw new RepoError('ref_not_found', `source ref not found: ${sourceRef}`)

      try {
        await runGit(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branchName}`], workingDir)
        throw new RepoError('branch_conflict', `branch already exists: ${branchName}`)
      } catch (err) {
        if (err instanceof RepoError && err.code === 'branch_conflict') throw err
      }
      await runGit(['checkout', '-b', branchName, resolvedCommit], workingDir)

      for (const file of bundle.files) {
        const target = safeJoin(workingDir, file.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, file.contents, 'utf8')
      }

      repoId = ulid().toLowerCase()
      db.insert(repos).values({
        id: repoId,
        configId: input.configId,
        name: bundle.summary.name,
        slug,
        worktreeName,
        worktreeSlug,
        originUrl,
        ref: sourceRef,
        workspacePath: workingDir,
        source: bundle.summary.source ?? (bundle.summary.githubFullName ? 'github' : 'url'),
        githubRepoId: null,
        githubFullName: bundle.summary.githubFullName ?? null,
        createdAt: new Date().toISOString(),
        workspaceId: input.workspaceId,
      }).run()

      return {
        configId: input.configId,
        repoId,
        workingDir,
        name: bundle.summary.name,
        worktreeName,
        sourceRef,
        branchName,
        resolvedCommit,
      }
    } catch (err) {
      if (repoId) db.delete(repos).where(eq(repos.id, repoId)).run()
      let residualArtifacts: string[] = []
      if (createdClone) {
        try {
          await fs.rm(workingDir, { recursive: true, force: true })
        } catch {
          residualArtifacts = [workingDir]
        }
      }
      if (residualArtifacts.length > 0) {
        if (err instanceof RepoError) {
          throw new RepoError(err.code, err.message, [...err.residualArtifacts, ...residualArtifacts])
        }
        throw new RepoError(
          'clone_failed',
          err instanceof Error ? err.message : String(err),
          residualArtifacts,
        )
      }
      throw err
    }
  }

  async deleteWorktree(repoId: string): Promise<{ id: string }> {
    const rows = db.select().from(repos).where(eq(repos.id, repoId)).limit(1).all()
    const row = rows[0]
    if (!row) throw new RepoError('not_found', 'work tree not found')
    const workspacePath = path.resolve(row.workspacePath)
    const cloneRoot = path.resolve(config.CC_WORKING_DIR, 'repos')
    if (workspacePath !== cloneRoot && !workspacePath.startsWith(cloneRoot + path.sep)) {
      throw new RepoError('delete_failed', 'work tree path is outside repo clone root')
    }
    await fs.rm(workspacePath, { recursive: true, force: true })
    db.delete(repos).where(eq(repos.id, repoId)).run()
    return { id: repoId }
  }
}

export const repoService = new RepoService()
