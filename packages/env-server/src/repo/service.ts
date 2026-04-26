import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ulid } from 'ulid'
import { config } from '../config.js'
import { getRepoConfig, listRepoConfigs, type RepoConfigSummary } from '../identity/client.js'

export class RepoError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_config' | 'clone_failed',
    message: string,
  ) {
    super(message)
    this.name = 'RepoError'
  }
}

export interface RepoCloneResult {
  configId: string
  workingDir: string
  name: string
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

class RepoService {
  async listConfigs(): Promise<RepoConfigSummary[]> {
    return listRepoConfigs()
  }

  async cloneConfig(configId: string): Promise<RepoCloneResult> {
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
    const workingDir = path.join(cloneRoot, `${slug}-${ulid().toLowerCase().slice(-8)}`)
    await fs.mkdir(cloneRoot, { recursive: true })

    const args = ['clone', '--progress']
    if (bundle.summary.ref) args.push('--branch', bundle.summary.ref)
    args.push(repoUrl(bundle.summary), workingDir)
    await runGitClone(args)

    for (const file of bundle.files) {
      const target = safeJoin(workingDir, file.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, file.contents, 'utf8')
    }

    return { configId, workingDir, name: bundle.summary.name }
  }
}

export const repoService = new RepoService()
