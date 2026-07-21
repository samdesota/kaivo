import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_PATCH_BYTES = 5 * 1024 * 1024
const MAX_COMMAND_BYTES = 5 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024

export interface GitRepository {
  root: string
  gitDir: string
  headOid: string | null
  branch: string | null
}

export interface OriginBranch {
  name: string
  ref: string
  oid: string
  isDefault: boolean
}

export interface OriginBranchesResult {
  repository: GitRepository
  branches: OriginBranch[]
  defaultBranch: OriginBranch | null
  defaultSource: 'symbolic-ref' | 'heuristic' | 'none'
}

export type GitDiffInput =
  | { cwd: string; kind: 'branch'; originBranch: string; includeUncommitted: boolean }
  | { cwd: string; kind: 'working-tree' }

export interface GitDiffFile {
  oldPath: string | null
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked'
  binary: boolean
  additions: number | null
  deletions: number | null
}

export interface GitDiffResult {
  repository: GitRepository
  kind: 'branch' | 'working-tree'
  baseRef: string | null
  mergeBaseOid: string | null
  patch: string
  files: GitDiffFile[]
  additions: number
  deletions: number
  byteCount: number
  truncated: boolean
  warnings: string[]
}

export type GitErrorCode =
  | 'not_repository'
  | 'head_unavailable'
  | 'origin_branch_not_found'
  | 'no_merge_base'
  | 'timeout'
  | 'output_limit'
  | 'command_failed'

export class GitError extends Error {
  constructor(
    public readonly code: GitErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

interface GitServiceOptions {
  gitBinary?: string
  timeoutMs?: number
  maxPatchBytes?: number
}

interface CommandResult {
  stdout: Buffer
  stderr: string
  code: number | null
  truncated: boolean
}

interface TrackedFile extends GitDiffFile {
  key: string
}

function splitNull(buffer: Buffer): string[] {
  const values = buffer.toString('utf8').split('\0')
  if (values.at(-1) === '') values.pop()
  return values
}

function statusName(status: string): GitDiffFile['status'] {
  switch (status[0]) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    default: return 'modified'
  }
}

function parseNameStatus(output: Buffer): TrackedFile[] {
  const fields = splitNull(output)
  const files: TrackedFile[] = []
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++]
    if (!rawStatus) throw new GitError('command_failed', 'Git returned malformed file status data')
    const renamed = rawStatus.startsWith('R') || rawStatus.startsWith('C')
    const oldPath = renamed ? fields[index++] : null
    const filePath = fields[index++]
    if (filePath === undefined || (renamed && oldPath === undefined)) {
      throw new GitError('command_failed', 'Git returned malformed file status data')
    }
    files.push({
      key: filePath,
      oldPath: oldPath ?? null,
      path: filePath,
      status: statusName(rawStatus),
      binary: false,
      additions: 0,
      deletions: 0,
    })
  }
  return files
}

function applyNumstat(files: TrackedFile[], output: Buffer): void {
  const byPath = new Map(files.map((file) => [file.key, file]))
  const fields = splitNull(output)
  for (let index = 0; index < fields.length;) {
    const header = fields[index++]
    if (!header) throw new GitError('command_failed', 'Git returned malformed numstat data')
    const firstTab = header.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : header.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) throw new GitError('command_failed', 'Git returned malformed numstat data')
    const added = header.slice(0, firstTab)
    const deleted = header.slice(firstTab + 1, secondTab)
    const inlinePath = header.slice(secondTab + 1)
    let filePath: string | undefined = inlinePath
    if (!filePath) {
      index++ // old path for a rename or copy
      filePath = fields[index++]
    }
    if (filePath === undefined) throw new GitError('command_failed', 'Git returned malformed numstat data')
    const file = byPath.get(filePath)
    if (!file) continue
    if (added === '-' || deleted === '-') {
      file.binary = true
      file.additions = null
      file.deletions = null
    } else {
      file.additions = Number(added)
      file.deletions = Number(deleted)
    }
  }
}

async function untrackedMetadata(root: string, relativePath: string): Promise<GitDiffFile> {
  const absolutePath = path.join(root, relativePath)
  const stat = await fs.lstat(absolutePath)
  const contents = stat.isSymbolicLink()
    ? Buffer.from(await fs.readlink(absolutePath))
    : await fs.readFile(absolutePath)
  const binary = contents.subarray(0, 8_000).includes(0)
  let additions: number | null = null
  if (!binary && contents.length > 0) {
    additions = 1
    for (const byte of contents) if (byte === 10) additions++
    if (contents.at(-1) === 10) additions--
  } else if (!binary) {
    additions = 0
  }
  return {
    oldPath: null,
    path: relativePath,
    status: 'untracked',
    binary,
    additions,
    deletions: binary ? null : 0,
  }
}

export class GitService {
  private readonly gitBinary: string
  private readonly timeoutMs: number
  private readonly maxPatchBytes: number

  constructor(options: GitServiceOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES
  }

  private run(
    cwd: string,
    args: string[],
    options: { allowCodes?: number[]; maxBytes?: number; truncate?: boolean } = {},
  ): Promise<CommandResult> {
    const allowCodes = options.allowCodes ?? [0]
    const maxBytes = options.maxBytes ?? MAX_COMMAND_BYTES
    return new Promise((resolve, reject) => {
      const detached = process.platform !== 'win32'
      const child = spawn(this.gitBinary, [
        '--no-pager',
        '-c', 'color.ui=false',
        ...args,
      ], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
      })
      const stdout: Buffer[] = []
      let stdoutBytes = 0
      let stderr = Buffer.alloc(0)
      let timedOut = false
      let truncated = false
      let settled = false

      const terminate = () => {
        try {
          if (detached && child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          // The command can exit between deciding to stop it and sending the signal.
        }
      }

      const timer = setTimeout(() => {
        timedOut = true
        terminate()
      }, this.timeoutMs)
      timer.unref()

      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return
        const remaining = maxBytes - stdoutBytes
        if (chunk.length > remaining) {
          if (remaining > 0) stdout.push(chunk.subarray(0, remaining))
          stdoutBytes = maxBytes
          truncated = true
          terminate()
          return
        }
        stdout.push(chunk)
        stdoutBytes += chunk.length
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) {
          stderr = Buffer.concat([stderr, chunk.subarray(0, MAX_STDERR_BYTES - stderr.length)])
        }
      })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new GitError('command_failed', error.message))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (timedOut) {
          reject(new GitError('timeout', `Git command timed out after ${this.timeoutMs}ms`))
          return
        }
        if (truncated && !options.truncate) {
          reject(new GitError('output_limit', 'Git command output exceeded its limit'))
          return
        }
        const stderrText = stderr.toString('utf8').trim()
        if (!truncated && !allowCodes.includes(code ?? -1)) {
          reject(new GitError('command_failed', stderrText || `Git exited with status ${code ?? 'unknown'}`))
          return
        }
        resolve({ stdout: Buffer.concat(stdout), stderr: stderrText, code, truncated })
      })
    })
  }

  async discoverGit(cwd: string): Promise<GitRepository | null> {
    let canonicalCwd: string
    try {
      canonicalCwd = await fs.realpath(cwd)
    } catch {
      return null
    }
    let topLevel: CommandResult
    try {
      topLevel = await this.run(canonicalCwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'])
    } catch (error) {
      if (error instanceof GitError && error.code === 'command_failed') return null
      throw error
    }
    const root = await fs.realpath(topLevel.stdout.toString('utf8').trim())
    const gitDirResult = await this.run(root, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'])
    const gitDir = await fs.realpath(gitDirResult.stdout.toString('utf8').trim())
    const headResult = await this.run(root, ['rev-parse', '--verify', 'HEAD'], { allowCodes: [0, 128] })
    const branchResult = await this.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowCodes: [0, 1] })
    return {
      root,
      gitDir,
      headOid: headResult.code === 0 ? headResult.stdout.toString('utf8').trim() : null,
      branch: branchResult.code === 0 ? branchResult.stdout.toString('utf8').trim() : null,
    }
  }

  private async requireRepository(cwd: string): Promise<GitRepository> {
    const repository = await this.discoverGit(cwd)
    if (!repository) throw new GitError('not_repository', 'not a Git repository')
    return repository
  }

  async originBranches(cwd: string): Promise<OriginBranchesResult> {
    const repository = await this.requireRepository(cwd)
    const refsResult = await this.run(repository.root, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
      'refs/remotes/origin/',
    ])
    const refs = refsResult.stdout.toString('utf8').split('\n').filter(Boolean).map((line) => {
      const [ref, oid] = line.split('\0')
      if (!ref || !oid) throw new GitError('command_failed', 'Git returned malformed origin ref data')
      return { ref, oid, name: ref.slice('refs/remotes/origin/'.length) }
    }).filter((branch) => branch.ref !== 'refs/remotes/origin/HEAD')
    const byRef = new Map(refs.map((branch) => [branch.ref, branch]))

    const symbolic = await this.run(repository.root, [
      'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD',
    ], { allowCodes: [0, 1] })
    const symbolicRef = symbolic.code === 0 ? symbolic.stdout.toString('utf8').trim() : null
    let defaultRef = symbolicRef && byRef.has(symbolicRef) ? symbolicRef : null
    let defaultSource: OriginBranchesResult['defaultSource'] = defaultRef ? 'symbolic-ref' : 'none'
    if (!defaultRef) {
      for (const candidate of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
        if (byRef.has(candidate)) {
          defaultRef = candidate
          defaultSource = 'heuristic'
          break
        }
      }
    }
    const branches = refs.map((branch) => ({ ...branch, isDefault: branch.ref === defaultRef }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return {
      repository,
      branches,
      defaultBranch: branches.find((branch) => branch.isDefault) ?? null,
      defaultSource,
    }
  }

  async diff(input: GitDiffInput): Promise<GitDiffResult> {
    const repository = await this.requireRepository(input.cwd)
    if (!repository.headOid && input.kind === 'branch') throw new GitError('head_unavailable', 'HEAD has no commit')

    let baseRef: string | null = null
    let mergeBaseOid: string | null = null
    let comparisonArgs: string[] | null
    if (input.kind === 'branch') {
      const origins = await this.originBranches(repository.root)
      const selected = origins.branches.find((branch) => branch.name === input.originBranch)
      if (!selected) throw new GitError('origin_branch_not_found', `origin branch not found: ${input.originBranch}`)
      baseRef = selected.ref
      const mergeBase = await this.run(repository.root, ['merge-base', 'HEAD', selected.ref], { allowCodes: [0, 1] })
      if (mergeBase.code !== 0) throw new GitError('no_merge_base', `HEAD and origin/${selected.name} have no merge base`)
      mergeBaseOid = mergeBase.stdout.toString('utf8').trim()
      comparisonArgs = input.includeUncommitted ? [mergeBaseOid] : [mergeBaseOid, 'HEAD']
    } else {
      comparisonArgs = repository.headOid ? ['HEAD'] : null
    }

    const commonDiffArgs = ['--no-ext-diff', '--no-textconv', '--find-renames', '--find-copies']
    const [statusResult, numstatResult, untrackedResult] = await Promise.all([
      comparisonArgs
        ? this.run(repository.root, ['diff', ...commonDiffArgs, '--name-status', '-z', ...comparisonArgs])
        : Promise.resolve({ stdout: Buffer.alloc(0), stderr: '', code: 0, truncated: false }),
      comparisonArgs
        ? this.run(repository.root, ['diff', ...commonDiffArgs, '--numstat', '-z', ...comparisonArgs])
        : Promise.resolve({ stdout: Buffer.alloc(0), stderr: '', code: 0, truncated: false }),
      input.kind === 'branch' && !input.includeUncommitted
        ? Promise.resolve({ stdout: Buffer.alloc(0), stderr: '', code: 0, truncated: false })
        : this.run(repository.root, repository.headOid
          ? ['ls-files', '--others', '--exclude-standard', '-z']
          : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    ])
    const trackedFiles = parseNameStatus(statusResult.stdout)
    applyNumstat(trackedFiles, numstatResult.stdout)
    const untrackedPaths = splitNull(untrackedResult.stdout)
    const untrackedFiles = await Promise.all(untrackedPaths.map((file) => untrackedMetadata(repository.root, file)))
    const files: GitDiffFile[] = [...trackedFiles.map(({ key: _key, ...file }) => file), ...untrackedFiles]

    const patchParts: Buffer[] = []
    let patchBytes = 0
    let truncated = false
    const appendPatch = (result: CommandResult) => {
      patchParts.push(result.stdout)
      patchBytes += result.stdout.length
      truncated ||= result.truncated
    }
    const trackedPatch = comparisonArgs
      ? await this.run(repository.root, [
        'diff', ...commonDiffArgs, '--binary', '--patch', ...comparisonArgs,
      ], { maxBytes: this.maxPatchBytes, truncate: true })
      : { stdout: Buffer.alloc(0), stderr: '', code: 0, truncated: false }
    appendPatch(trackedPatch)
    if (!truncated) {
      for (const file of untrackedPaths) {
        const remaining = this.maxPatchBytes - patchBytes
        if (remaining === 0) {
          truncated = true
          break
        }
        const untrackedPatch = await this.run(repository.root, [
          'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--patch', '--', '/dev/null', file,
        ], { allowCodes: [0, 1], maxBytes: remaining, truncate: true })
        appendPatch(untrackedPatch)
        if (truncated) break
      }
    }

    const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0)
    const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0)
    return {
      repository,
      kind: input.kind,
      baseRef,
      mergeBaseOid,
      patch: Buffer.concat(patchParts).toString('utf8'),
      files,
      additions,
      deletions,
      byteCount: patchBytes,
      truncated,
      warnings: truncated ? [`Patch truncated at ${this.maxPatchBytes} bytes`] : [],
    }
  }
}

export const gitService = new GitService()
