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
import { ulid } from 'ulid'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { shellSessions, type ShellOwnerKind } from '../db/schema.js'
import { logger } from '../logger.js'

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

export class ShellError extends Error {
  constructor(
    public code: 'not_found' | 'invalid_cwd',
    message: string,
  ) {
    super(message)
    this.name = 'ShellError'
  }
}

export interface ShellInfo {
  id: string
  cols: number
  rows: number
  cwd: string
  ownerKind: ShellOwnerKind
  ownerSessionId: string | null
  exitCode: number | null
  createdAt: Date
  lastActivityAt: Date
  alive: boolean
}

type Subscriber = (chunk: string) => void

interface ShellHandle {
  id: string
  pty: IPty
  term: HeadlessTerminalType
  serialize: SerializeAddonType
  cols: number
  rows: number
  cwd: string
  ownerKind: ShellOwnerKind
  ownerSessionId: string | null
  exitCode: number | null
  createdAt: Date
  lastActivityAt: Date
  subscribers: Set<Subscriber>
  disposed: boolean
}

class TerminalService {
  private shells = new Map<string, ShellHandle>()

  async create(opts: {
    cols?: number
    rows?: number
    cwd?: string
    ownerKind?: ShellOwnerKind
    ownerSessionId?: string | null
  }): Promise<ShellInfo> {
    const id = ulid().toLowerCase()
    const cols = opts.cols ?? DEFAULT_COLS
    const rows = opts.rows ?? DEFAULT_ROWS
    const cwd = opts.cwd && opts.cwd.trim() !== '' ? opts.cwd : config.CC_WORKING_DIR
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

    const shell = process.env.SHELL ?? '/bin/bash'
    const pty = ptySpawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    })

    const now = new Date()
    const handle: ShellHandle = {
      id,
      pty,
      term,
      serialize,
      cols,
      rows,
      cwd,
      ownerKind,
      ownerSessionId,
      exitCode: null,
      createdAt: now,
      lastActivityAt: now,
      subscribers: new Set(),
      disposed: false,
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
      // Leave the handle around so late attaches can read final scrollback;
      // the UI is expected to dispose.
    })

    this.shells.set(id, handle)
    db.insert(shellSessions)
      .values({
        id,
        cwd,
        cols,
        rows,
        ownerKind,
        ownerSessionId: ownerSessionId ?? null,
        createdAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
      })
      .run()

    return toInfo(handle)
  }

  get(id: string): ShellInfo {
    const h = this.shells.get(id)
    if (!h) throw new ShellError('not_found', `shell ${id} not found`)
    return toInfo(h)
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].filter((h) => h.ownerKind === 'human').map(toInfo)
  }

  write(id: string, data: string): void {
    const h = this.shells.get(id)
    if (!h) throw new ShellError('not_found', `shell ${id} not found`)
    h.pty.write(data)
    h.lastActivityAt = new Date()
  }

  resize(id: string, cols: number, rows: number): ShellInfo {
    const h = this.shells.get(id)
    if (!h) throw new ShellError('not_found', `shell ${id} not found`)
    h.pty.resize(cols, rows)
    h.cols = cols
    h.rows = rows
    h.term.resize(cols, rows)
    db.update(shellSessions)
      .set({ cols, rows, lastActivityAt: new Date().toISOString() })
      .where(eq(shellSessions.id, id))
      .run()
    return toInfo(h)
  }

  attach(id: string, onChunk: Subscriber): { snapshot: string; detach: () => void } {
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

  dispose(id: string): void {
    const h = this.shells.get(id)
    if (!h) return
    try {
      h.pty.kill()
    } catch {
      // already gone
    }
    h.disposed = true
    this.shells.delete(id)
    db.delete(shellSessions).where(eq(shellSessions.id, id)).run()
  }

  shutdownAll(): void {
    for (const h of this.shells.values()) {
      try {
        h.pty.kill()
      } catch {
        // ignore
      }
    }
    this.shells.clear()
  }
}

function toInfo(h: ShellHandle): ShellInfo {
  return {
    id: h.id,
    cols: h.cols,
    rows: h.rows,
    cwd: h.cwd,
    ownerKind: h.ownerKind,
    ownerSessionId: h.ownerSessionId,
    exitCode: h.exitCode,
    createdAt: h.createdAt,
    lastActivityAt: h.lastActivityAt,
    alive: !h.disposed && h.exitCode === null,
  }
}

export const terminalService = new TerminalService()
