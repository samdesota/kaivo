import { createRequire } from 'node:module'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import type {
  Terminal as HeadlessTerminalType,
  ITerminalOptions,
  ITerminalInitOnlyOptions,
} from '@xterm/headless'
import type {
  SerializeAddon as SerializeAddonType,
  ISerializeOptions,
} from '@xterm/addon-serialize'
import type { ITerminalAddon } from '@xterm/xterm'
import { eq } from 'drizzle-orm'

// These packages ship as CJS/UMD bundles whose named exports are not
// statically detectable by Node's ESM loader. Resolve them via createRequire
// so the compiled bundle (which keeps them as external imports) doesn't
// choke at runtime.
const localRequire = createRequire(import.meta.url)
const { Terminal: HeadlessTerminal } = localRequire('@xterm/headless') as {
  Terminal: new (
    opts?: ITerminalOptions & ITerminalInitOnlyOptions,
  ) => HeadlessTerminalType
}
const { SerializeAddon } = localRequire('@xterm/addon-serialize') as {
  SerializeAddon: new () => SerializeAddonType & {
    serialize(opts?: ISerializeOptions): string
  }
}
import { ulid } from 'ulid'
import { spawn as procSpawn, type ChildProcess } from 'node:child_process'
import { db } from '../db/client.js'
import { shellSessions, type ShellOwnerKind } from '../db/schema.js'
import { logger } from '../logger.js'
import { sandboxManager } from '../sandbox/manager.js'

const SCROLLBACK_LINES = 10_000
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
const RUN_ONCE_MAX_BYTES = 10 * 1024 * 1024
// Run-once streaming ring buffer: a late-attaching UI sees this tail.
const RUN_ONCE_STREAM_BUFFER_BYTES = 200 * 1024
// Retention after a run-once shell exits, so a user can still scroll back.
const DEFAULT_RUN_ONCE_RETENTION_MS = 10 * 60 * 1000

export class ShellError extends Error {
  constructor(
    public code: 'not_found' | 'sandbox_unavailable' | 'timeout' | 'too_large',
    message: string,
  ) {
    super(message)
    this.name = 'ShellError'
  }
}

export interface ShellInfo {
  id: string
  sandboxId: string
  cols: number
  rows: number
  cwd: string
  ownerKind: ShellOwnerKind
  ownerSessionId: string | null
  isRunOnce: boolean
  exitCode: number | null
  createdAt: Date
  lastActivityAt: Date
  alive: boolean
}

type Subscriber = (chunk: string) => void

interface ShellHandle {
  id: string
  sandboxId: string
  pty: IPty | null
  child: ChildProcess | null
  term: HeadlessTerminalType
  serialize: SerializeAddonType
  cols: number
  rows: number
  cwd: string
  ownerKind: ShellOwnerKind
  ownerSessionId: string | null
  isRunOnce: boolean
  exitCode: number | null
  createdAt: Date
  lastActivityAt: Date
  subscribers: Set<Subscriber>
  disposed: boolean
  retentionTimer: NodeJS.Timeout | null
}

export interface RunOnceStreamOpts {
  sandboxId: string
  cmd: string
  cwd?: string
  cols?: number
  rows?: number
  ownerSessionId?: string | null
  onStdout?: (chunk: Buffer) => void
  onStderr?: (chunk: Buffer) => void
  signal?: AbortSignal
}

export interface RunOnceStreamHandle {
  shellId: string
  exitPromise: Promise<{ exitCode: number; truncated: boolean }>
  dispose(): Promise<void>
}

class TerminalService {
  private shells = new Map<string, ShellHandle>()
  private runOnceRetentionMs = DEFAULT_RUN_ONCE_RETENTION_MS

  constructor() {
    // When a sandbox is deleted/archived, drop its shells.
    sandboxManager.onEvent((evt) => {
      if (evt.type === 'deleted' || evt.type === 'archived') {
        this.disposeSandbox(evt.sandboxId)
      }
    })
  }

  async create(opts: {
    sandboxId: string
    cols?: number
    rows?: number
    cwd?: string
    ownerKind?: ShellOwnerKind
    ownerSessionId?: string | null
  }): Promise<ShellInfo> {
    const sb = await sandboxManager.get(opts.sandboxId)
    if (!sb) throw new ShellError('not_found', 'sandbox not found')
    if (!sb.containerId || !sb.running) {
      throw new ShellError('sandbox_unavailable', 'sandbox is not running')
    }

    const id = ulid().toLowerCase()
    const cols = opts.cols ?? DEFAULT_COLS
    const rows = opts.rows ?? DEFAULT_ROWS
    const cwd = opts.cwd && opts.cwd.trim() !== '' ? opts.cwd : '/workspace'
    const ownerKind: ShellOwnerKind = opts.ownerKind ?? 'human'
    const ownerSessionId = opts.ownerSessionId ?? null

    const term = new HeadlessTerminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    const serialize = new SerializeAddon()
    term.loadAddon(serialize as unknown as ITerminalAddon)

    const pty = ptySpawn(
      'docker',
      ['exec', '-it', '-w', cwd, '-e', 'TERM=xterm-256color', sb.containerId, 'bash'],
      {
        name: 'xterm-256color',
        cols,
        rows,
        env: process.env as { [k: string]: string },
      },
    )

    const now = new Date()
    const handle: ShellHandle = {
      id,
      sandboxId: opts.sandboxId,
      pty,
      child: null,
      term,
      serialize,
      cols,
      rows,
      cwd,
      ownerKind,
      ownerSessionId,
      isRunOnce: false,
      exitCode: null,
      createdAt: now,
      lastActivityAt: now,
      subscribers: new Set(),
      disposed: false,
      retentionTimer: null,
    }

    pty.onData((data) => {
      handle.lastActivityAt = new Date()
      term.write(data)
      for (const sub of handle.subscribers) {
        try {
          sub(data)
        } catch (err) {
          logger.warn({ err, id }, 'subscriber threw')
        }
      }
    })
    pty.onExit(({ exitCode }) => {
      logger.info({ id, exitCode }, 'pty exited')
      handle.exitCode = exitCode
      this.dispose(id)
    })

    this.shells.set(id, handle)
    await db.insert(shellSessions).values({
      id,
      sandboxId: opts.sandboxId,
      cwd,
      cols,
      rows,
      ownerKind,
      ownerSessionId,
    })

    return this.toInfo(handle)
  }

  get(id: string): ShellInfo | null {
    const h = this.shells.get(id)
    return h ? this.toInfo(h) : null
  }

  /**
   * Shells visible in the Shells panel: human and agent-persistent shells.
   * Run-once agent shells host live tool output and don't auto-surface here.
   */
  listBySandbox(sandboxId: string): ShellInfo[] {
    const out: ShellInfo[] = []
    for (const h of this.shells.values()) {
      if (h.sandboxId === sandboxId && !h.isRunOnce) out.push(this.toInfo(h))
    }
    return out
  }

  attach(
    id: string,
    writer: (chunk: string) => void,
  ): { snapshot: string; unsubscribe: () => void } | null {
    const h = this.shells.get(id)
    if (!h || h.disposed) return null
    const snapshot = h.serialize.serialize({ scrollback: SCROLLBACK_LINES })
    h.subscribers.add(writer)
    return {
      snapshot,
      unsubscribe: () => {
        h.subscribers.delete(writer)
      },
    }
  }

  sendKeys(id: string, data: string): void {
    const h = this.shells.get(id)
    if (!h || h.disposed || !h.pty) return
    h.pty.write(data)
    h.lastActivityAt = new Date()
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const h = this.shells.get(id)
    if (!h || h.disposed) return
    h.cols = cols
    h.rows = rows
    if (h.pty) {
      try {
        h.pty.resize(cols, rows)
      } catch (err) {
        logger.warn({ err, id }, 'pty resize failed')
      }
    }
    h.term.resize(cols, rows)
    await db.update(shellSessions).set({ cols, rows }).where(eq(shellSessions.id, id))
  }

  dispose(id: string): void {
    const h = this.shells.get(id)
    if (!h) return
    h.disposed = true
    this.shells.delete(id)
    if (h.retentionTimer) {
      clearTimeout(h.retentionTimer)
      h.retentionTimer = null
    }
    for (const sub of h.subscribers) {
      try {
        sub('\r\n\x1b[2m[session closed]\x1b[0m\r\n')
      } catch {
        // ignore
      }
    }
    h.subscribers.clear()
    if (h.pty) {
      try {
        h.pty.kill()
      } catch {
        // ignore — probably already exited
      }
    }
    if (h.child) {
      try {
        h.child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
    try {
      h.term.dispose()
    } catch {
      // ignore
    }
    db.delete(shellSessions).where(eq(shellSessions.id, id)).catch((err) => {
      logger.warn({ err, id }, 'delete shell_session row failed')
    })
  }

  disposeSandbox(sandboxId: string): void {
    const ids: string[] = []
    for (const h of this.shells.values()) {
      if (h.sandboxId === sandboxId) ids.push(h.id)
    }
    for (const id of ids) this.dispose(id)
  }

  async runOnce(opts: {
    sandboxId: string
    cmd: string
    cwd?: string
    timeoutMs?: number
  }): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
    const sb = await sandboxManager.get(opts.sandboxId)
    if (!sb) throw new ShellError('not_found', 'sandbox not found')
    if (!sb.containerId || !sb.running) {
      throw new ShellError('sandbox_unavailable', 'sandbox is not running')
    }

    const cwd = opts.cwd && opts.cwd.trim() !== '' ? opts.cwd : '/workspace'
    const args = [
      'exec',
      '-w',
      cwd,
      sb.containerId,
      'bash',
      '-lc',
      opts.cmd,
    ]
    return new Promise((resolve, reject) => {
      const child = procSpawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const stdoutParts: Buffer[] = []
      const stderrParts: Buffer[] = []
      let stdoutLen = 0
      let stderrLen = 0
      let truncated = false
      let timedOut = false

      const appendCapped = (parts: Buffer[], currentLen: number, chunk: Buffer): number => {
        if (currentLen >= RUN_ONCE_MAX_BYTES) {
          truncated = true
          return currentLen
        }
        const remain = RUN_ONCE_MAX_BYTES - currentLen
        if (chunk.length > remain) {
          truncated = true
          parts.push(Buffer.from(chunk.subarray(0, remain)))
          return currentLen + remain
        }
        parts.push(Buffer.from(chunk))
        return currentLen + chunk.length
      }

      child.stdout.on('data', (c: Buffer) => {
        stdoutLen = appendCapped(stdoutParts, stdoutLen, c)
      })
      child.stderr.on('data', (c: Buffer) => {
        stderrLen = appendCapped(stderrParts, stderrLen, c)
      })

      const timeout = opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            try {
              child.kill('SIGKILL')
            } catch {
              // ignore
            }
          }, opts.timeoutMs)
        : null
      if (timeout) timeout.unref()

      child.on('error', (err) => {
        if (timeout) clearTimeout(timeout)
        reject(new ShellError('sandbox_unavailable', `docker exec failed: ${err.message}`))
      })
      child.on('exit', (code, signal) => {
        if (timeout) clearTimeout(timeout)
        if (timedOut) {
          reject(new ShellError('timeout', `command timed out after ${opts.timeoutMs}ms`))
          return
        }
        resolve({
          stdout: Buffer.concat(stdoutParts).toString('utf8'),
          stderr: Buffer.concat(stderrParts).toString('utf8'),
          exitCode: code ?? (signal ? 128 : 0),
          truncated,
        })
      })
    })
  }

  /**
   * Streaming sibling of `runOnce`: runs a command in the sandbox, streams
   * stdout/stderr through a headless xterm so the existing `/ws/shell/:id`
   * path can attach and replay scrollback, and resolves `exitPromise` when
   * the command completes. After exit, the handle is retained for
   * `runOnceRetentionMs` (default 10 min) so late-attaching UIs still see
   * the full scrollback.
   *
   * A `shell_sessions` row is written synchronously with
   * `owner_kind='agent'` before the handle is returned; the row is deleted
   * on dispose.
   */
  runOnceStream(opts: RunOnceStreamOpts): RunOnceStreamHandle {
    const id = ulid().toLowerCase()
    const cols = opts.cols ?? DEFAULT_COLS
    const rows = opts.rows ?? DEFAULT_ROWS
    const cwd = opts.cwd && opts.cwd.trim() !== '' ? opts.cwd : '/workspace'
    const ownerSessionId = opts.ownerSessionId ?? null

    const term = new HeadlessTerminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    const serialize = new SerializeAddon()
    term.loadAddon(serialize as unknown as ITerminalAddon)

    const now = new Date()
    const handle: ShellHandle = {
      id,
      sandboxId: opts.sandboxId,
      pty: null,
      child: null,
      term,
      serialize,
      cols,
      rows,
      cwd,
      ownerKind: 'agent',
      ownerSessionId,
      isRunOnce: true,
      exitCode: null,
      createdAt: now,
      lastActivityAt: now,
      subscribers: new Set(),
      disposed: false,
      retentionTimer: null,
    }
    this.shells.set(id, handle)

    let ringBytes = 0
    let truncated = false
    const writeChunk = (chunk: Buffer) => {
      if (handle.disposed) return
      handle.lastActivityAt = new Date()
      if (ringBytes + chunk.length > RUN_ONCE_STREAM_BUFFER_BYTES) {
        // Headless xterm keeps its own scrollback; we only use ringBytes to
        // mark the overall output as truncated for the exit event.
        truncated = true
      }
      ringBytes += chunk.length
      const str = chunk.toString('utf8')
      term.write(str)
      for (const sub of handle.subscribers) {
        try {
          sub(str)
        } catch (err) {
          logger.warn({ err, id }, 'run-once subscriber threw')
        }
      }
    }

    const exitPromise = (async (): Promise<{ exitCode: number; truncated: boolean }> => {
      const sb = await sandboxManager.get(opts.sandboxId)
      if (!sb) throw new ShellError('not_found', 'sandbox not found')
      if (!sb.containerId || !sb.running) {
        throw new ShellError('sandbox_unavailable', 'sandbox is not running')
      }

      await db.insert(shellSessions).values({
        id,
        sandboxId: opts.sandboxId,
        cwd,
        cols,
        rows,
        ownerKind: 'agent',
        ownerSessionId,
      })

      return await new Promise<{ exitCode: number; truncated: boolean }>((resolve, reject) => {
        if (handle.disposed) {
          resolve({ exitCode: 130, truncated: false })
          return
        }
        const child = procSpawn(
          'docker',
          ['exec', '-w', cwd, sb.containerId!, 'bash', '-lc', opts.cmd],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        handle.child = child

        const onAbort = () => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }
        if (opts.signal) {
          if (opts.signal.aborted) onAbort()
          else opts.signal.addEventListener('abort', onAbort, { once: true })
        }

        child.stdout.on('data', (c: Buffer) => {
          writeChunk(c)
          opts.onStdout?.(c)
        })
        child.stderr.on('data', (c: Buffer) => {
          writeChunk(c)
          opts.onStderr?.(c)
        })

        child.on('error', (err) => {
          opts.signal?.removeEventListener('abort', onAbort)
          reject(new ShellError('sandbox_unavailable', `docker exec failed: ${err.message}`))
        })
        child.on('exit', (code, signal) => {
          opts.signal?.removeEventListener('abort', onAbort)
          const exitCode = code ?? (signal ? 128 : 0)
          handle.exitCode = exitCode
          handle.child = null
          // Flush xterm's write buffer so a late attach's snapshot reflects
          // everything we saw from the child.
          term.write('', () => {
            if (!handle.disposed && this.runOnceRetentionMs > 0) {
              handle.retentionTimer = setTimeout(
                () => this.dispose(id),
                this.runOnceRetentionMs,
              )
              handle.retentionTimer.unref?.()
            } else if (!handle.disposed) {
              this.dispose(id)
            }
            resolve({ exitCode, truncated })
          })
        })
      })
    })()
    exitPromise.catch(() => undefined) // prevent unhandled rejection

    return {
      shellId: id,
      exitPromise,
      dispose: async () => {
        this.dispose(id)
      },
    }
  }

  private toInfo(h: ShellHandle): ShellInfo {
    return {
      id: h.id,
      sandboxId: h.sandboxId,
      cols: h.cols,
      rows: h.rows,
      cwd: h.cwd,
      ownerKind: h.ownerKind,
      ownerSessionId: h.ownerSessionId,
      isRunOnce: h.isRunOnce,
      exitCode: h.exitCode,
      createdAt: h.createdAt,
      lastActivityAt: h.lastActivityAt,
      alive: !h.disposed && h.exitCode === null,
    }
  }

  // Test helpers.
  __countShells(): number {
    return this.shells.size
  }
  /** Reduce retention for tests. */
  __setRunOnceRetentionMs(ms: number): void {
    this.runOnceRetentionMs = ms
  }
}

export const terminalService = new TerminalService()
