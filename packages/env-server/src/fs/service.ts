import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import chokidar, { type FSWatcher } from 'chokidar'
import { config } from '../config.js'
import { logger } from '../logger.js'

export class FsError extends Error {
  constructor(
    public code: 'not_found' | 'path_traversal' | 'not_readable' | 'unsupported' | 'already_exists',
    message: string,
  ) {
    super(message)
    this.name = 'FsError'
  }
}

export interface FsEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number | null
  mtime: Date | null
}

export interface ReadResult {
  path: string
  size: number
  mtime: Date
  encoding: 'utf8' | 'binary'
  content: string | null
  binary: boolean
  tooLarge: boolean
}

export interface RawFileResult {
  path: string
  size: number
  mtime: Date
  content: Buffer
}

export interface FsEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
}

export interface GitTrackedFileResult {
  root: string
  path: string
  relativePath: string
}

const MAX_READ_BYTES = 5 * 1024 * 1024
const WATCH_DEBOUNCE_MS = 50

function workingRoot(): string {
  return path.resolve(config.CC_WORKING_DIR)
}

export function resolveWorkspacePath(rawPath: string): string {
  const root = workingRoot()
  const trimmed = rawPath.replace(/^\/+/, '')
  const joined = path.resolve(root, trimmed)
  if (joined !== root && !joined.startsWith(root + path.sep)) {
    throw new FsError('path_traversal', 'path escapes workspace')
  }
  return joined
}

export function toWorkspaceRelative(absPath: string): string {
  const root = workingRoot()
  if (absPath === root) return '/'
  if (absPath.startsWith(root + path.sep)) {
    return '/' + absPath.slice(root.length + 1).split(path.sep).join('/')
  }
  return absPath
}

export async function listDirectory(dirPath: string): Promise<FsEntry[]> {
  const abs = resolveWorkspacePath(dirPath)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FsError('not_found', 'directory not found')
    }
    throw err
  }
  const out: FsEntry[] = []
  for (const e of entries) {
    const absChild = path.join(abs, e.name)
    let size: number | null = null
    let mtime: Date | null = null
    let kind: FsEntry['kind'] = 'other'
    if (e.isFile()) kind = 'file'
    else if (e.isDirectory()) kind = 'directory'
    else if (e.isSymbolicLink()) kind = 'symlink'

    if (kind === 'file' || kind === 'directory') {
      try {
        const st = await fs.stat(absChild)
        if (kind === 'file') size = st.size
        mtime = st.mtime
      } catch {
        // inaccessible — keep nulls
      }
    }
    out.push({
      name: e.name,
      path: toWorkspaceRelative(absChild),
      kind,
      size,
      mtime,
    })
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === 'directory') return -1
      if (b.kind === 'directory') return 1
    }
    return a.name.localeCompare(b.name)
  })
  return out
}

export async function searchGitTrackedFiles(roots: string[], query: string, limit = 120): Promise<GitTrackedFileResult[]> {
  const q = query.trim().toLowerCase()
  const uniqueRoots = Array.from(new Set(roots.map((root) => path.resolve(root))))
  const out: GitTrackedFileResult[] = []
  for (const root of uniqueRoots) {
    if (out.length >= limit) break
    try {
      const files = await gitLsFiles(root)
      for (const relativePath of files) {
        if (out.length >= limit) break
        if (q && !relativePath.toLowerCase().includes(q) && !path.basename(relativePath).toLowerCase().includes(q)) continue
        out.push({ root, relativePath, path: path.join(root, relativePath) })
      }
    } catch {
      // Non-git or inaccessible roots are skipped; callers can show an empty state if all roots fail.
    }
  }
  return out
}

function gitLsFiles(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['ls-files'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) reject(new FsError('unsupported', stderr.trim() || 'not a git repository'))
      else resolve(stdout.split('\n').map((line) => line.trim()).filter(Boolean))
    })
  })
}

export async function readFile(
  filePath: string,
  opts: { absolute?: boolean } = {},
): Promise<ReadResult> {
  const abs = opts.absolute ? requireAbsolute(filePath) : resolveWorkspacePath(filePath)
  let stat
  try {
    stat = await fs.stat(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FsError('not_found', 'file not found')
    }
    throw err
  }
  if (!stat.isFile()) throw new FsError('not_readable', 'not a regular file')

  const reportedPath = opts.absolute ? abs : toWorkspaceRelative(abs)
  if (stat.size > MAX_READ_BYTES) {
    return {
      path: reportedPath,
      size: stat.size,
      mtime: stat.mtime,
      encoding: 'binary',
      content: null,
      binary: true,
      tooLarge: true,
    }
  }

  const buf = await fs.readFile(abs)
  const binary = looksBinary(buf)
  return {
    path: reportedPath,
    size: stat.size,
    mtime: stat.mtime,
    encoding: binary ? 'binary' : 'utf8',
    content: binary ? null : buf.toString('utf8'),
    binary,
    tooLarge: false,
  }
}

export async function readRawFile(
  filePath: string,
  opts: { absolute?: boolean } = {},
): Promise<RawFileResult> {
  const abs = opts.absolute ? requireAbsolute(filePath) : resolveWorkspacePath(filePath)
  let stat
  try {
    stat = await fs.stat(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FsError('not_found', 'file not found')
    }
    throw err
  }
  if (!stat.isFile()) throw new FsError('not_readable', 'not a regular file')

  return {
    path: opts.absolute ? abs : toWorkspaceRelative(abs),
    size: stat.size,
    mtime: stat.mtime,
    content: await fs.readFile(abs),
  }
}

export async function writeFile(
  filePath: string,
  content: string,
  opts: { absolute?: boolean } = {},
): Promise<void> {
  const abs = opts.absolute ? requireAbsolute(filePath) : resolveWorkspacePath(filePath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
}

export async function createDirectory(parentPath: string, name: string): Promise<BrowseEntry> {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new FsError('unsupported', 'invalid directory name')
  }
  const parent = requireAbsolute(parentPath)
  const target = path.join(parent, trimmed)
  try {
    await fs.mkdir(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new FsError('already_exists', 'directory already exists')
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FsError('not_found', 'parent directory not found')
    }
    throw err
  }
  return { name: trimmed, path: target }
}

function requireAbsolute(p: string): string {
  if (!path.isAbsolute(p)) {
    throw new FsError('not_readable', 'absolute path required when absolute=true')
  }
  return path.resolve(p)
}

// A single shared watcher for the env's one workingDir.
let watcher: FSWatcher | null = null
let ready = false
const listeners = new Set<(evt: FsEvent) => void>()
let pending = new Map<string, FsEvent>()
let flushTimer: NodeJS.Timeout | null = null

function startWatcher(): void {
  if (watcher) return
  const root = workingRoot()
  watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 500,
    binaryInterval: 1000,
    ignored: (p: string) => {
      const rel = path.relative(root, p)
      if (!rel || rel.startsWith('..')) return false
      const parts = rel.split(path.sep)
      return parts.some((seg) => seg === 'node_modules' || seg === '.git')
    },
  })
  for (const type of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
    watcher.on(type, (p: string) => {
      const evt: FsEvent = { type, path: toWorkspaceRelative(p) }
      pending.set(`${type}:${evt.path}`, evt)
      scheduleFlush()
    })
  }
  watcher.on('ready', () => {
    ready = true
  })
  watcher.on('error', (err) => logger.warn({ err }, 'watcher error'))
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const events = [...pending.values()]
    pending = new Map()
    for (const evt of events) {
      for (const l of listeners) {
        try {
          l(evt)
        } catch (err) {
          logger.warn({ err }, 'fs listener threw')
        }
      }
    }
  }, WATCH_DEBOUNCE_MS)
  flushTimer.unref()
}

export function watchWorkspace(fn: (evt: FsEvent) => void): () => void {
  listeners.add(fn)
  if (listeners.size === 1) startWatcher()
  return () => {
    listeners.delete(fn)
  }
}

export function watchFilePath(
  filePath: string,
  opts: { absolute?: boolean } = {},
  fn: (evt: FsEvent) => void,
): () => void {
  const abs = opts.absolute ? requireAbsolute(filePath) : resolveWorkspacePath(filePath)
  const watcher = chokidar.watch(abs, {
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 500,
    binaryInterval: 1000,
  })
  const reportedPath = opts.absolute ? abs : toWorkspaceRelative(abs)
  for (const type of ['add', 'change', 'unlink'] as const) {
    watcher.on(type, () => fn({ type, path: reportedPath }))
  }
  watcher.on('error', (err) => logger.warn({ err }, 'file watcher error'))
  return () => {
    void watcher.close()
  }
}

export function isWatcherReady(): boolean {
  return ready
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export interface BrowseEntry {
  name: string
  /** Absolute filesystem path. */
  path: string
}

export interface BrowseResult {
  /** Absolute path of the directory we listed. */
  path: string
  /** Absolute path of the user's home — useful as a "go home" anchor. */
  home: string
  /** Absolute path of CC_WORKING_DIR — useful as a "go default" anchor. */
  defaultPath: string
  /** Absolute path of the parent of `path`, or null at filesystem root. */
  parent: string | null
  /** Subdirectories of `path`, sorted: visible first, then hidden, name asc. */
  dirs: BrowseEntry[]
  /** Files in `path`, sorted: visible first, then hidden, name asc. */
  files: BrowseEntry[]
}

/**
 * Folder picker source. Lists subdirectories of the requested path,
 * exposing directories only because the picker is for choosing a working dir.
 *
 * `absPath` may be omitted (defaults to CC_WORKING_DIR) or absolute.
 * Symlinks are resolved before listing.
 */
export async function browseHome(absPath?: string): Promise<BrowseResult> {
  const home = path.resolve(os.homedir())
  const defaultPath = path.resolve(config.CC_WORKING_DIR)
  const requested = absPath ? path.resolve(absPath) : defaultPath
  let real: string
  try {
    real = await fs.realpath(requested)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FsError('not_found', 'directory not found')
    }
    throw err
  }
  // Resolve the working-dir anchor too — it might itself be a symlink.
  let realDefault = defaultPath
  try {
    realDefault = await fs.realpath(defaultPath)
  } catch {
    // Working dir doesn't exist on disk; fall back to the unresolved path.
  }
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(real, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new FsError('not_readable', 'directory not readable')
    }
    throw err
  }
  const dirs: BrowseEntry[] = []
  const files: BrowseEntry[] = []
  for (const e of entries) {
    if (!e.isDirectory() && !e.isFile() && !e.isSymbolicLink()) continue
    // For symlinks, stat to confirm the target is a directory; skip
    // dangling links so the picker doesn't show clickable dead entries.
    if (e.isSymbolicLink()) {
      try {
        const st = await fs.stat(path.join(real, e.name))
        if (st.isDirectory()) {
          dirs.push({ name: e.name, path: path.join(real, e.name) })
        } else if (st.isFile()) {
          files.push({ name: e.name, path: path.join(real, e.name) })
        }
      } catch {
        continue
      }
      continue
    }
    if (e.isDirectory()) dirs.push({ name: e.name, path: path.join(real, e.name) })
    else files.push({ name: e.name, path: path.join(real, e.name) })
  }
  const sortBrowseEntries = (a: BrowseEntry, b: BrowseEntry) => {
    const aHidden = a.name.startsWith('.')
    const bHidden = b.name.startsWith('.')
    if (aHidden !== bHidden) return aHidden ? 1 : -1
    return a.name.localeCompare(b.name)
  }
  dirs.sort(sortBrowseEntries)
  files.sort(sortBrowseEntries)
  const parent = path.dirname(real)
  return {
    path: real,
    home,
    defaultPath: realDefault,
    parent: parent === real ? null : parent,
    dirs,
    files,
  }
}
