import { spawn } from 'node:child_process'
import { ulid } from 'ulid'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repoConfigs, repos, type RepoSource } from '../db/schema.js'
import { logger } from '../logger.js'
import { sandboxManager } from '../sandbox/manager.js'
import { jobManager, type Job } from '../jobs/manager.js'
import { githubService, GitHubError } from '../github/service.js'
import { registerProject } from '../agent/opencode.js'
import { repoConfigService } from './configs.js'

export class RepoError extends Error {
  constructor(
    public code:
      | 'not_found'
      | 'sandbox_unavailable'
      | 'invalid_url'
      | 'slug_conflict'
      | 'github_not_connected'
      | 'config_not_found'
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
  configId: string | null
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

function deriveSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'repo'
}

function toSummary(row: typeof repos.$inferSelect): RepoSummary {
  return {
    id: row.id,
    sandboxId: row.sandboxId,
    configId: row.configId,
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

  /** Kick off a clone job from a global repo config. */
  async add(opts: {
    sandboxId: string
    configId: string
    refOverride?: string
  }): Promise<{ jobId: string; repoId: string }> {
    const sb = await sandboxManager.get(opts.sandboxId)
    if (!sb) throw new RepoError('not_found', 'sandbox not found')
    if (!sb.running || !sb.containerId) {
      throw new RepoError('sandbox_unavailable', 'sandbox is not running')
    }

    const cfgRows = await db
      .select()
      .from(repoConfigs)
      .where(eq(repoConfigs.id, opts.configId))
      .limit(1)
    const cfg = cfgRows[0]
    if (!cfg) throw new RepoError('config_not_found', 'repo config not found')

    let cloneUrlPromise: Promise<string>
    if (cfg.source === 'github') {
      if (!cfg.githubFullName) throw new RepoError('invalid_url', 'config missing github full name')
      const status = await githubService.status()
      if (!status.connected || !status.installed) {
        throw new RepoError('github_not_connected', 'GitHub App not connected')
      }
      cloneUrlPromise = githubService.buildAuthedCloneUrl(cfg.githubFullName)
    } else {
      cloneUrlPromise = Promise.resolve(cfg.originUrl)
    }

    const ref = opts.refOverride?.trim() || cfg.ref || ''
    const displayName = cfg.name
    const slug = deriveSlug(displayName)

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
      metadata: { repoId, slug, source: cfg.source, originUrl: cfg.originUrl, configId: cfg.id },
    })

    void this.runClone({
      job,
      containerId: sb.containerId,
      repoId,
      sandboxId: opts.sandboxId,
      configId: cfg.id,
      slug,
      name: displayName,
      originUrl: cfg.originUrl,
      workspacePath,
      ref,
      source: cfg.source,
      githubFullName: cfg.githubFullName,
      cloneUrlPromise,
    })

    return { jobId: job.id, repoId }
  }

  private async runClone(ctx: {
    job: Job
    containerId: string
    repoId: string
    sandboxId: string
    configId: string
    slug: string
    name: string
    originUrl: string
    workspacePath: string
    ref: string
    source: RepoSource
    githubFullName: string | null
    cloneUrlPromise: Promise<string>
  }): Promise<void> {
    try {
      await jobManager.update(ctx.job.id, { state: 'running', message: 'preparing clone' })
      jobManager.log(ctx.job.id, 'info', `cloning ${ctx.originUrl} → ${ctx.workspacePath}`)

      const cloneUrl = await ctx.cloneUrlPromise
      const safeDisplayUrl = redactUrl(cloneUrl)
      jobManager.log(ctx.job.id, 'info', `starting: git clone ${safeDisplayUrl}`)

      await this.dockerExec(ctx.containerId, ['mkdir', '-p', REPO_ROOT], ctx.job.id)

      const args = ['exec', ctx.containerId, 'git', 'clone', '--progress']
      if (ctx.ref) args.push('--branch', ctx.ref)
      args.push(cloneUrl, ctx.workspacePath)

      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
        const onChunk = (buf: Buffer) => {
          for (const line of buf.toString('utf8').split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed) continue
            jobManager.log(ctx.job.id, 'info', redactString(trimmed))
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

      let resolvedRef = ctx.ref
      if (!resolvedRef) {
        const { stdout } = await this.dockerExecCapture(
          ctx.containerId,
          ['git', '-C', ctx.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        )
        resolvedRef = stdout.trim() || 'HEAD'
      }

      // Materialize associated config files into the workspace.
      const files = await repoConfigService.readAllFiles(ctx.configId)
      for (const f of files) {
        const abs = `${ctx.workspacePath}/${f.path}`
        try {
          await this.dockerWriteFile(ctx.containerId, abs, f.contents)
          jobManager.log(ctx.job.id, 'info', `wrote ${f.path} (${f.contents.length} bytes)`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          jobManager.log(ctx.job.id, 'warn', `failed to write ${f.path}: ${msg}`)
        }
      }

      await db.insert(repos).values({
        id: ctx.repoId,
        sandboxId: ctx.sandboxId,
        configId: ctx.configId,
        name: ctx.name,
        slug: ctx.slug,
        originUrl: ctx.originUrl,
        ref: resolvedRef,
        workspacePath: ctx.workspacePath,
        source: ctx.source,
        githubRepoId: null,
        githubFullName: ctx.githubFullName,
      })

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

  /**
   * Stream `contents` into a file inside the container. We invoke a shell
   * that mkdir -p's the parent directory then `cat`s stdin into the file.
   * Pass the absolute target as a literal arg ($1) to keep it out of the
   * shell command string.
   */
  private dockerWriteFile(containerId: string, absPath: string, contents: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'docker',
        [
          'exec',
          '-i',
          containerId,
          'sh',
          '-c',
          'mkdir -p "$(dirname "$1")" && cat > "$1"',
          'sh',
          absPath,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const errParts: Buffer[] = []
      child.stderr.on('data', (b) => errParts.push(Buffer.from(b)))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else {
          const msg = Buffer.concat(errParts).toString('utf8').slice(0, 500)
          reject(new Error(`write failed (${code}): ${msg}`))
        }
      })
      child.stdin.write(contents)
      child.stdin.end()
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
  return s
    .replace(/https:\/\/x-access-token:[^@\s]+@/g, 'https://x-access-token:***@')
    .replace(/https:\/\/[^:@\s]+:[^@\s]+@/g, 'https://***:***@')
}

export const repoService = new RepoService()
void logger
