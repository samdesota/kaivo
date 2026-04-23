import { spawn } from 'node:child_process'
import { ulid } from 'ulid'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repos, type RepoSource } from '../db/schema.js'
import { logger } from '../logger.js'
import { sandboxManager } from '../sandbox/manager.js'
import { jobManager, type Job } from '../jobs/manager.js'
import { githubService, GitHubError } from '../github/service.js'
import { registerProject } from '../agent/opencode.js'

export class RepoError extends Error {
  constructor(
    public code:
      | 'not_found'
      | 'sandbox_unavailable'
      | 'invalid_url'
      | 'slug_conflict'
      | 'github_not_connected'
      | 'clone_failed',
    message: string,
  ) {
    super(message)
    this.name = 'RepoError'
  }
}

export interface RepoSummary {
  id: string
  sandboxId: string
  name: string
  slug: string
  originUrl: string
  ref: string
  workspacePath: string
  source: RepoSource
  githubFullName: string | null
  createdAt: Date
}

const REPO_ROOT = '/workspace/repos'

// scp-style git URL: `git@host:path` (no scheme). Conservative match.
const SCP_SSH_URL_RE = /^[a-z_][a-z0-9_-]*@[a-z0-9.-]+:[^\s]+$/i

function isValidUrl(url: string): boolean {
  if (SCP_SSH_URL_RE.test(url)) return true
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' ||
      u.protocol === 'http:' ||
      u.protocol === 'git:' ||
      u.protocol === 'ssh:'
    )
  } catch {
    return false
  }
}

function deriveSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'repo'
}

function deriveNameFromUrl(url: string): string {
  // scp-style: take the part after the last `/` (or after `:` if no `/`).
  if (SCP_SSH_URL_RE.test(url)) {
    const after = url.split(':').slice(1).join(':')
    const last = after.split('/').filter(Boolean).pop() || 'repo'
    return last.replace(/\.git$/, '')
  }
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop() || 'repo'
    return last.replace(/\.git$/, '')
  } catch {
    return 'repo'
  }
}

function toSummary(row: typeof repos.$inferSelect): RepoSummary {
  return {
    id: row.id,
    sandboxId: row.sandboxId,
    name: row.name,
    slug: row.slug,
    originUrl: row.originUrl,
    ref: row.ref,
    workspacePath: row.workspacePath,
    source: row.source,
    githubFullName: row.githubFullName,
    createdAt: row.createdAt,
  }
}

class RepoService {
  async list(sandboxId: string): Promise<RepoSummary[]> {
    const rows = await db
      .select()
      .from(repos)
      .where(eq(repos.sandboxId, sandboxId))
    rows.sort((a, b) => a.slug.localeCompare(b.slug))
    return rows.map(toSummary)
  }

  async get(repoId: string): Promise<RepoSummary | null> {
    const rows = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1)
    return rows[0] ? toSummary(rows[0]) : null
  }

  async remove(sandboxId: string, repoId: string): Promise<void> {
    const row = await db
      .select()
      .from(repos)
      .where(and(eq(repos.id, repoId), eq(repos.sandboxId, sandboxId)))
      .limit(1)
    if (!row[0]) throw new RepoError('not_found', 'repo not found')
    const sb = await sandboxManager.get(sandboxId)
    const containerId = sb?.containerId
    if (containerId && sb?.running) {
      await new Promise<void>((resolve) => {
        const child = spawn(
          'docker',
          ['exec', containerId, 'rm', '-rf', row[0]!.workspacePath],
          { stdio: 'ignore' },
        )
        child.on('exit', () => resolve())
        child.on('error', () => resolve())
      })
    }
    await db.delete(repos).where(eq(repos.id, repoId))
  }

  /** Kick off a clone job. Returns the job id immediately; subscribers tail progress. */
  async add(opts: {
    sandboxId: string
    source: RepoSource
    url?: string
    repoFullName?: string
    ref?: string
  }): Promise<{ jobId: string; repoId: string }> {
    const sb = await sandboxManager.get(opts.sandboxId)
    if (!sb) throw new RepoError('not_found', 'sandbox not found')
    if (!sb.running || !sb.containerId) {
      throw new RepoError('sandbox_unavailable', 'sandbox is not running')
    }

    let originUrl: string
    let displayName: string
    const githubRepoId: string | null = null
    let githubFullName: string | null = null
    let cloneUrlPromise: Promise<string>
    const ref: string = opts.ref ?? ''

    if (opts.source === 'github') {
      if (!opts.repoFullName || !/^[^/]+\/[^/]+$/.test(opts.repoFullName)) {
        throw new RepoError('invalid_url', 'repoFullName must be "owner/name"')
      }
      // Verify github is connected
      const status = await githubService.status()
      if (!status.connected || !status.installed) {
        throw new RepoError('github_not_connected', 'GitHub App not connected')
      }
      githubFullName = opts.repoFullName
      displayName = opts.repoFullName.split('/')[1]!
      originUrl = `https://github.com/${opts.repoFullName}.git`
      cloneUrlPromise = githubService.buildAuthedCloneUrl(opts.repoFullName)
    } else {
      if (!opts.url || !isValidUrl(opts.url)) {
        throw new RepoError('invalid_url', 'url must be a valid http(s), git, ssh, or git@host:path URL')
      }
      originUrl = opts.url
      displayName = deriveNameFromUrl(opts.url)
      cloneUrlPromise = Promise.resolve(opts.url)
    }

    const slug = deriveSlug(displayName)

    // Ensure no slug conflict inside this sandbox.
    const conflict = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.sandboxId, opts.sandboxId), eq(repos.slug, slug)))
      .limit(1)
    if (conflict[0]) throw new RepoError('slug_conflict', `repo "${slug}" already exists`)

    const repoId = ulid().toLowerCase()
    const workspacePath = `${REPO_ROOT}/${slug}`

    const job = await jobManager.create({
      kind: 'repo.clone',
      sandboxId: opts.sandboxId,
      message: `cloning ${displayName}…`,
      metadata: { repoId, slug, source: opts.source, originUrl },
    })

    // Run the clone asynchronously.
    void this.runClone({
      job,
      containerId: sb.containerId,
      repoId,
      sandboxId: opts.sandboxId,
      slug,
      name: displayName,
      originUrl,
      workspacePath,
      ref,
      source: opts.source,
      githubRepoId,
      githubFullName,
      cloneUrlPromise,
    })

    return { jobId: job.id, repoId }
  }

  private async runClone(ctx: {
    job: Job
    containerId: string
    repoId: string
    sandboxId: string
    slug: string
    name: string
    originUrl: string
    workspacePath: string
    ref: string
    source: RepoSource
    githubRepoId: string | null
    githubFullName: string | null
    cloneUrlPromise: Promise<string>
  }): Promise<void> {
    try {
      await jobManager.update(ctx.job.id, { state: 'running', message: 'preparing clone' })
      jobManager.log(ctx.job.id, 'info', `cloning ${ctx.originUrl} → ${ctx.workspacePath}`)

      const cloneUrl = await ctx.cloneUrlPromise
      const safeDisplayUrl = redactUrl(cloneUrl)
      jobManager.log(ctx.job.id, 'info', `starting: git clone ${safeDisplayUrl}`)

      // Ensure repos dir exists inside the container, then clone.
      await this.dockerExec(ctx.containerId, ['mkdir', '-p', REPO_ROOT], ctx.job.id)

      const args = [
        'exec',
        ctx.containerId,
        'git',
        'clone',
        '--progress',
      ]
      if (ctx.ref) args.push('--branch', ctx.ref)
      args.push(cloneUrl, ctx.workspacePath)

      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
        const onChunk = (buf: Buffer) => {
          for (const line of buf.toString('utf8').split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed) continue
            jobManager.log(ctx.job.id, 'info', redactString(trimmed))
            // crude progress: look for "Receiving objects:  42%"
            const m = trimmed.match(/:\s+(\d{1,3})%/)
            if (m) {
              const pct = Math.min(99, Math.max(0, parseInt(m[1]!, 10)))
              void jobManager.update(ctx.job.id, { progressPct: pct })
            }
          }
        }
        child.stdout.on('data', onChunk)
        child.stderr.on('data', onChunk)
        child.on('error', (err) => {
          jobManager.log(ctx.job.id, 'error', `spawn error: ${err.message}`)
          resolve(-1)
        })
        child.on('exit', (code) => resolve(code ?? -1))
      })

      if (exitCode !== 0) {
        throw new RepoError('clone_failed', `git clone exited ${exitCode}`)
      }

      // Resolve ref (if none was provided) by asking git what HEAD points at.
      let resolvedRef = ctx.ref
      if (!resolvedRef) {
        const { stdout } = await this.dockerExecCapture(
          ctx.containerId,
          ['git', '-C', ctx.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        )
        resolvedRef = stdout.trim() || 'HEAD'
      }

      await db.insert(repos).values({
        id: ctx.repoId,
        sandboxId: ctx.sandboxId,
        name: ctx.name,
        slug: ctx.slug,
        originUrl: ctx.originUrl,
        ref: resolvedRef,
        workspacePath: ctx.workspacePath,
        source: ctx.source,
        githubRepoId: ctx.githubRepoId,
        githubFullName: ctx.githubFullName,
      })

      // Tell OpenCode about the new repo so it shows up in the agent's
      // folder picker. Non-fatal — the clone succeeded either way.
      void registerProject(ctx.sandboxId, ctx.workspacePath).catch(() => {})

      await jobManager.update(ctx.job.id, {
        state: 'succeeded',
        progressPct: 100,
        message: 'clone complete',
      })
      jobManager.log(ctx.job.id, 'info', 'done')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code =
        err instanceof GitHubError
          ? err.code === 'not_connected'
            ? 'github not connected'
            : err.code === 'not_installed'
              ? 'github app not installed'
              : err.message
          : err instanceof RepoError
            ? err.message
            : msg
      jobManager.log(ctx.job.id, 'error', redactString(String(code)))
      await jobManager.update(ctx.job.id, {
        state: 'failed',
        error: redactString(String(code)),
        message: 'clone failed',
      })
      // Best-effort cleanup of partial checkout.
      await this.dockerExec(ctx.containerId, ['rm', '-rf', ctx.workspacePath], ctx.job.id).catch(
        () => {},
      )
    }
  }

  private dockerExec(
    containerId: string,
    cmd: string[],
    jobId?: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['exec', containerId, ...cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
      const parts: Buffer[] = []
      child.stdout.on('data', (b) => parts.push(Buffer.from(b)))
      child.stderr.on('data', (b) => parts.push(Buffer.from(b)))
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else {
          const msg = Buffer.concat(parts).toString('utf8').slice(0, 500)
          if (jobId) jobManager.log(jobId, 'warn', `exec failed (${code}): ${msg}`)
          reject(new Error(`docker exec failed with code ${code}: ${msg}`))
        }
      })
      child.on('error', reject)
    })
  }

  private dockerExecCapture(
    containerId: string,
    cmd: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['exec', containerId, ...cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (b) => out.push(Buffer.from(b)))
      child.stderr.on('data', (b) => err.push(Buffer.from(b)))
      child.on('exit', (code) =>
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          exitCode: code ?? -1,
        }),
      )
      child.on('error', reject)
    })
  }
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.username || u.password) {
      u.username = u.username ? '***' : ''
      u.password = u.password ? '***' : ''
    }
    return u.toString()
  } catch {
    return url
  }
}

function redactString(s: string): string {
  // Redact bearer/basic tokens that might sneak into git's stderr.
  return s
    .replace(/https:\/\/x-access-token:[^@\s]+@/g, 'https://x-access-token:***@')
    .replace(/https:\/\/[^:@\s]+:[^@\s]+@/g, 'https://***:***@')
}

export const repoService = new RepoService()
void logger
