import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { config } from '../config.js'
import { logger } from '../logger.js'

export class FsError extends Error {
  constructor(
    public code: 'not_found' | 'path_traversal' | 'not_readable' | 'unsupported',
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

export interface FsEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
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

export async function readFile(filePath: string): Promise<ReadResult> {
  const abs = resolveWorkspacePath(filePath)
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

  if (stat.size > MAX_READ_BYTES) {
    return {
      path: toWorkspaceRelative(abs),
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
    path: toWorkspaceRelative(abs),
    size: stat.size,
    mtime: stat.mtime,
    encoding: binary ? 'binary' : 'utf8',
    content: binary ? null : buf.toString('utf8'),
    binary,
    tooLarge: false,
  }
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  const abs = resolveWorkspacePath(filePath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
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
