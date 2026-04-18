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
import { spawn as procSpawn } from 'node:child_process'
import { db } from '../db/client.js'
import { shellSessions } from '../db/schema.js'
import { logger } from '../logger.js'
import { sandboxManager } from '../sandbox/manager.js'

const SCROLLBACK_LINES = 10_000
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
const RUN_ONCE_MAX_BYTES = 10 * 1024 * 1024

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
  createdAt: Date
  lastActivityAt: Date
  alive: boolean
}

type Subscriber = (chunk: string) => void

interface ShellHandle {
  id: string
  sandboxId: string
  pty: IPty
  term: HeadlessTerminalType
  serialize: SerializeAddonType
  cols: number
  rows: number
  cwd: string
  createdAt: Date
  lastActivityAt: Date
  subscribers: Set<Subscriber>
  disposed: boolean
}

class TerminalService {
  private shells = new Map<string, ShellHandle>()

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
      term,
      serialize,
      cols,
      rows,
      cwd,
      createdAt: now,
      lastActivityAt: now,
      subscribers: new Set(),
      disposed: false,
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
      this.dispose(id)
    })

    this.shells.set(id, handle)
    await db.insert(shellSessions).values({
      id,
      sandboxId: opts.sandboxId,
      cwd,
      cols,
      rows,
    })

    return this.toInfo(handle)
  }

  get(id: string): ShellInfo | null {
    const h = this.shells.get(id)
    return h ? this.toInfo(h) : null
  }

  listBySandbox(sandboxId: string): ShellInfo[] {
    const out: ShellInfo[] = []
    for (const h of this.shells.values()) {
      if (h.sandboxId === sandboxId) out.push(this.toInfo(h))
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
    if (!h || h.disposed) return
    h.pty.write(data)
    h.lastActivityAt = new Date()
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const h = this.shells.get(id)
    if (!h || h.disposed) return
    h.cols = cols
    h.rows = rows
    try {
      h.pty.resize(cols, rows)
    } catch (err) {
      logger.warn({ err, id }, 'pty resize failed')
    }
    h.term.resize(cols, rows)
    await db.update(shellSessions).set({ cols, rows }).where(eq(shellSessions.id, id))
  }

  dispose(id: string): void {
    const h = this.shells.get(id)
    if (!h) return
    h.disposed = true
    this.shells.delete(id)
    for (const sub of h.subscribers) {
      try {
        sub('\r\n\x1b[2m[session closed]\x1b[0m\r\n')
      } catch {
        // ignore
      }
    }
    h.subscribers.clear()
    try {
      h.pty.kill()
    } catch {
      // ignore — probably already exited
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

  private toInfo(h: ShellHandle): ShellInfo {
    return {
      id: h.id,
      sandboxId: h.sandboxId,
      cols: h.cols,
      rows: h.rows,
      cwd: h.cwd,
      createdAt: h.createdAt,
      lastActivityAt: h.lastActivityAt,
      alive: !h.disposed,
    }
  }

  // Test helper.
  __countShells(): number {
    return this.shells.size
  }
}

export const terminalService = new TerminalService()
