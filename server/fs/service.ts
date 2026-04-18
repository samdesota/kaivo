import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { logger } from '../logger.js'
import { workspaceDir } from '../sandbox/paths.js'

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
  sandboxId: string
  path: string // workspace-relative with leading "/"
}

const MAX_READ_BYTES = 5 * 1024 * 1024
const WATCH_DEBOUNCE_MS = 50

/**
 * Resolve a workspace-relative path, rejecting traversal. Input must be a
 * POSIX-style path that begins (conceptually) at the sandbox workspace root.
 */
export function resolveWorkspacePath(sandboxId: string, rawPath: string): string {
  const root = workspaceDir(sandboxId)
  const trimmed = rawPath.replace(/^\/+/, '')
  const joined = path.resolve(root, trimmed)
  const rootResolved = path.resolve(root)
  if (joined !== rootResolved && !joined.startsWith(rootResolved + path.sep)) {
    throw new FsError('path_traversal', 'path escapes workspace')
  }
  return joined
}

export function toWorkspaceRelative(sandboxId: string, absPath: string): string {
  const root = path.resolve(workspaceDir(sandboxId))
  if (absPath === root) return '/'
  if (absPath.startsWith(root + path.sep)) {
    return '/' + absPath.slice(root.length + 1).split(path.sep).join('/')
  }
  return absPath
}

export async function listDirectory(sandboxId: string, dirPath: string): Promise<FsEntry[]> {
  const abs = resolveWorkspacePath(sandboxId, dirPath)
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

    if (kind === 'file') {
      try {
        const st = await fs.stat(absChild)
        size = st.size
        mtime = st.mtime
      } catch {
        // inaccessible — keep nulls
      }
    } else if (kind === 'directory') {
      try {
        const st = await fs.stat(absChild)
        mtime = st.mtime
      } catch {
        // ignore
      }
    }
    out.push({
      name: e.name,
      path: toWorkspaceRelative(sandboxId, absChild),
      kind,
      size,
      mtime,
    })
  }
  // Directories first, then files, alphabetical.
  out.sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === 'directory') return -1
      if (b.kind === 'directory') return 1
    }
    return a.name.localeCompare(b.name)
  })
  return out
}

export async function readFile(sandboxId: string, filePath: string): Promise<ReadResult> {
  const abs = resolveWorkspacePath(sandboxId, filePath)
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
      path: toWorkspaceRelative(sandboxId, abs),
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
    path: toWorkspaceRelative(sandboxId, abs),
    size: stat.size,
    mtime: stat.mtime,
    encoding: binary ? 'binary' : 'utf8',
    content: binary ? null : buf.toString('utf8'),
    binary,
    tooLarge: false,
  }
}

export async function writeFile(
  sandboxId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const abs = resolveWorkspacePath(sandboxId, filePath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
}

/**
 * A shared watcher per sandbox. Emits coarse events; subscribers filter if
 * they care about a subtree.
 */
class SandboxWatcher {
  private watcher: FSWatcher | null = null
  private ready = false
  private listeners = new Set<(evt: FsEvent) => void>()
  private pending = new Map<string, FsEvent>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private sandboxId: string) {}

  start(): void {
    if (this.watcher) return
    const root = workspaceDir(this.sandboxId)
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p: string) => {
        const rel = path.relative(root, p)
        if (!rel || rel.startsWith('..')) return false
        const parts = rel.split(path.sep)
        return parts.some((seg) => seg === 'node_modules' || seg === '.git')
      },
    })
    for (const type of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
      this.watcher.on(type, (p: string) => {
        const evt: FsEvent = {
          type,
          sandboxId: this.sandboxId,
          path: toWorkspaceRelative(this.sandboxId, p),
        }
        this.pending.set(`${type}:${evt.path}`, evt)
        this.scheduleFlush()
      })
    }
    this.watcher.on('ready', () => {
      this.ready = true
    })
    this.watcher.on('error', (err) => logger.warn({ err, sandboxId: this.sandboxId }, 'watcher error'))
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const events = [...this.pending.values()]
      this.pending.clear()
      for (const evt of events) {
        for (const l of this.listeners) {
          try {
            l(evt)
          } catch (err) {
            logger.warn({ err }, 'fs listener threw')
          }
        }
      }
    }, WATCH_DEBOUNCE_MS)
    this.flushTimer.unref()
  }

  subscribe(fn: (evt: FsEvent) => void): () => void {
    this.listeners.add(fn)
    if (this.listeners.size === 1) this.start()
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.stop()
    }
  }

  isReady(): boolean {
    return this.ready
  }

  async stop(): Promise<void> {
    if (!this.watcher) return
    await this.watcher.close()
    this.watcher = null
    this.ready = false
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pending.clear()
  }
}

const watchers = new Map<string, SandboxWatcher>()

export function watchSandbox(
  sandboxId: string,
  fn: (evt: FsEvent) => void,
): () => void {
  let w = watchers.get(sandboxId)
  if (!w) {
    w = new SandboxWatcher(sandboxId)
    watchers.set(sandboxId, w)
  }
  return w.subscribe(fn)
}

export async function stopSandboxWatcher(sandboxId: string): Promise<void> {
  const w = watchers.get(sandboxId)
  if (!w) return
  await w.stop()
  watchers.delete(sandboxId)
}

/**
 * Null-byte heuristic: check the first N bytes for null. Fast, enough to hide
 * truly-binary blobs from a textarea. Doesn't try to be clever about UTF-16.
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

// Exposed for tests.
export const __internals = { MAX_READ_BYTES, looksBinary }
