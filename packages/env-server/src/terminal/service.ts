import { createRequire } from 'node:module'
import os from 'node:os'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { spawn as procSpawn, type ChildProcess } from 'node:child_process'
import { shellEnv } from 'shell-env'
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
import { ulid } from 'ulid'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { agentSessions, shellSessions, type ShellOwnerKind } from '../db/schema.js'
import { logger } from '../logger.js'

/**
 * Resolve the cwd a new shell should land in. Precedence:
 *   1. explicit `cwd` argument (the agent picked one),
 *   2. the working dir stored on the owning agent session, if any,
 *   3. CC_WORKING_DIR.
 *
 * Without (2), shells opened from a session with a custom picker dir
 * still landed in CC_WORKING_DIR — defeating the per-session picker.
 */
function resolveCwd(
  cwd: string | undefined,
  ownerAgentSessionId: string | null,
  ownerSessionId: string | null,
): string {
  if (cwd && cwd.trim() !== '') return cwd
  if (ownerAgentSessionId) {
    const row = db
      .select({ workingDir: agentSessions.workingDir })
      .from(agentSessions)
      .where(eq(agentSessions.id, ownerAgentSessionId))
      .limit(1)
      .all()[0]
    if (row?.workingDir) return row.workingDir
  }
  if (ownerSessionId) {
    const row = db
      .select({ workingDir: agentSessions.workingDir })
      .from(agentSessions)
      .where(eq(agentSessions.opencodeSessionId, ownerSessionId))
      .limit(1)
      .all()[0]
    if (row?.workingDir) return row.workingDir
  }
  return config.CC_WORKING_DIR
}

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

const SCROLLBACK_LINES = 10_000
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
const RUN_ONCE_STREAM_BUFFER_BYTES = 200 * 1024
const DEFAULT_RUN_ONCE_RETENTION_MS = 10 * 60 * 1000
const DEFAULT_LOGIN_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'

async function userShellEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  try {
    return { ...(await shellEnv()), ...extra }
  } catch (err) {
    logger.warn({ err }, 'failed to read login shell environment')
  }

  const user = os.userInfo()
  const shell = (user as { shell?: string }).shell ?? '/bin/bash'
  const env: NodeJS.ProcessEnv = {
    HOME: user.homedir,
    LOGNAME: user.username,
    PATH: DEFAULT_LOGIN_PATH,
    SHELL: shell,
    USER: user.username,
  }
  return { ...env, ...extra }
}

export class ShellError extends Error {
  constructor(
    public code: 'not_found' | 'invalid_cwd' | 'timeout',
    message: string,
  ) {
    super(message)
    this.name = 'ShellError'
  }
}

export interface ShellInfo {
  id: string
  workspaceId: string | null
  cols: number
  rows: number
  cwd: string
  ownerKind: ShellOwnerKind
  ownerAgentSessionId: string | null
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
  workspaceId: string | null
  pty: IPty | null
  child: ChildProcess | null
  term: HeadlessTerminalType
  serialize: SerializeAddonType
  cols: number
  rows: number
  cwd: string
  ownerKind: ShellOwnerKind
  ownerAgentSessionId: string | null
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
  cmd: string
  workspaceId?: string | null
  cwd?: string
  cols?: number
  rows?: number
  ownerSessionId?: string | null
  ownerAgentSessionId?: string | null
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

  async create(opts: {
    workspaceId?: string | null
    cols?: number
    rows?: number
    cwd?: string
    ownerKind?: ShellOwnerKind
    ownerSessionId?: string | null
    ownerAgentSessionId?: string | null
  }): Promise<ShellInfo> {
    const id = ulid().toLowerCase()
    const cols = opts.cols ?? DEFAULT_COLS
    const rows = opts.rows ?? DEFAULT_ROWS
    const ownerKind: ShellOwnerKind = opts.ownerKind ?? 'human'
    const workspaceId = opts.workspaceId ?? null
    const ownerSessionId = opts.ownerSessionId ?? null
    const ownerAgentSessionId = opts.ownerAgentSessionId ?? null
    const cwd = resolveCwd(opts.cwd, ownerAgentSessionId, ownerSessionId)

    const term = new HeadlessTerminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    const serialize = new SerializeAddon()
    term.loadAddon(serialize as unknown as ITerminalAddon)

    const env = await userShellEnv({ TERM: 'xterm-256color' })
    const shell = env.SHELL ?? '/bin/bash'
    const pty = ptySpawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    })

    const now = new Date()
    const handle: ShellHandle = {
      id,
      workspaceId,
      pty,
      child: null,
      term,
      serialize,
      cols,
      rows,
      cwd,
      ownerKind,
      ownerAgentSessionId,
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
      for (const s of handle.subscribers) {
        try {
          s(data)
        } catch (err) {
          logger.warn({ err, id }, 'subscriber threw')
        }
      }
    })

    pty.onExit(({ exitCode }) => {
      handle.exitCode = exitCode
      // Leave around so late attaches can read final scrollback.
    })

    this.shells.set(id, handle)
    db.insert(shellSessions)
      .values({
        id,
        workspaceId,
        cwd,
        cols,
        rows,
        ownerKind,
        ownerAgentSessionId,
        ownerSessionId: ownerSessionId ?? null,
        createdAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
      })
      .run()

    return toInfo(handle)
  }

  get(id: string): ShellInfo | null {
    const h = this.shells.get(id)
    return h ? toInfo(h) : null
  }

  list(input: { workspaceId?: string } = {}): ShellInfo[] {
    return [...this.shells.values()]
      .filter((h) => !h.isRunOnce)
      .filter((h) => !input.workspaceId || h.workspaceId === input.workspaceId)
      .map(toInfo)
  }

  write(id: string, data: string): void {
    const h = this.shells.get(id)
    if (!h) throw new ShellError('not_found', `shell ${id} not found`)
    if (h.pty) {
      h.pty.write(data)
    }
    h.lastActivityAt = new Date()
  }

  /** Send raw bytes to a persistent agent shell. */
  sendKeys(id: string, data: string): void {
    const h = this.shells.get(id)
    if (!h || h.disposed || !h.pty) return
    h.pty.write(data)
    h.lastActivityAt = new Date()
  }

  resize(id: string, cols: number, rows: number): ShellInfo {
    const h = this.shells.get(id)
    if (!h) throw new ShellError('not_found', `shell ${id} not found`)
    if (h.pty) h.pty.resize(cols, rows)
    h.cols = cols
    h.rows = rows
    h.term.resize(cols, rows)
    db.update(shellSessions)
      .set({ cols, rows, lastActivityAt: new Date().toISOString() })
      .where(eq(shellSessions.id, id))
      .run()
    return toInfo(h)
  }

  attach(
    id: string,
    onChunk: Subscriber,
  ): { snapshot: string; detach: () => void } {
    const h = this.shells.get(id)
    if (!h) throw new ShellError('not_found', `shell ${id} not found`)
    const snapshot = h.serialize.serialize()
    h.subscribers.add(onChunk)
    return {
      snapshot,
      detach: () => {
        h.subscribers.delete(onChunk)
      },
    }
  }

  /** Current xterm scrollback, or null if disposed/unknown. */
  snapshot(id: string): string | null {
    const h = this.shells.get(id)
    if (!h || h.disposed) return null
    return h.serialize.serialize({ scrollback: SCROLLBACK_LINES })
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
        // ignore
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
    db.delete(shellSessions).where(eq(shellSessions.id, id)).run()
  }

  shutdownAll(): void {
    for (const id of [...this.shells.keys()]) this.dispose(id)
  }

  /**
   * Streaming command exec: forks a bash subshell, pipes its stdout/stderr
   * through a headless xterm so the existing `/ws/shell/:id` path can
   * attach and replay scrollback, and resolves `exitPromise` when the
   * command completes. Retained for a few minutes post-exit so a late
   * attach still sees the scrollback.
   */
  runOnceStream(opts: RunOnceStreamOpts): RunOnceStreamHandle {
    const id = ulid().toLowerCase()
    const cols = opts.cols ?? DEFAULT_COLS
    const rows = opts.rows ?? DEFAULT_ROWS
    const ownerSessionId = opts.ownerSessionId ?? null
    const workspaceId = opts.workspaceId ?? null
    const ownerAgentSessionId = opts.ownerAgentSessionId ?? null
    const cwd = resolveCwd(opts.cwd, ownerAgentSessionId, ownerSessionId)

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
      workspaceId,
      pty: null,
      child: null,
      term,
      serialize,
      cols,
      rows,
      cwd,
      ownerKind: 'agent',
      ownerAgentSessionId,
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
      db.insert(shellSessions)
        .values({
          id,
          workspaceId,
          cwd,
          cols,
          rows,
          ownerKind: 'agent',
          ownerAgentSessionId,
          ownerSessionId,
          createdAt: now.toISOString(),
          lastActivityAt: now.toISOString(),
        })
        .run()

      const env = await userShellEnv()
      return await new Promise<{ exitCode: number; truncated: boolean }>((resolve, reject) => {
        if (handle.disposed) {
          resolve({ exitCode: 130, truncated: false })
          return
        }
        const child = procSpawn('bash', ['-lc', opts.cmd], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
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
          reject(new ShellError('not_found', `bash spawn failed: ${err.message}`))
        })
        child.on('exit', (code, signal) => {
          opts.signal?.removeEventListener('abort', onAbort)
          const exitCode = code ?? (signal ? 128 : 0)
          handle.exitCode = exitCode
          handle.child = null
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
    exitPromise.catch(() => undefined)

    return {
      shellId: id,
      exitPromise,
      dispose: async () => {
        this.dispose(id)
      },
    }
  }

  __setRunOnceRetentionMs(ms: number): void {
    this.runOnceRetentionMs = ms
  }
}

function toInfo(h: ShellHandle): ShellInfo {
  return {
    id: h.id,
    workspaceId: h.workspaceId,
    cols: h.cols,
    rows: h.rows,
    cwd: h.cwd,
    ownerKind: h.ownerKind,
    ownerAgentSessionId: h.ownerAgentSessionId,
    ownerSessionId: h.ownerSessionId,
    isRunOnce: h.isRunOnce,
    exitCode: h.exitCode,
    createdAt: h.createdAt,
    lastActivityAt: h.lastActivityAt,
    alive: !h.disposed && h.exitCode === null,
  }
}

export const terminalService = new TerminalService()
