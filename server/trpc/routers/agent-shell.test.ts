import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Observable } from '@trpc/server/observable'

/**
 * End-to-end tests for the agentShell.* tRPC router via createCaller,
 * with stubbed Postgres and `child_process.spawn`. The goal is to prove
 * token auth, scope checking, and the runOnce/open/write/close/tail
 * procedures work without requiring a real sandbox.
 */

interface ShellRow {
  id: string
  sandboxId: string
  cwd: string
  cols: number
  rows: number
  ownerKind: 'human' | 'agent'
  ownerSessionId: string | null
  createdAt: Date
  lastActivityAt: Date
}
interface TokenRow {
  tokenHash: string
  sandboxId: string
  issuedAt: Date
  revokedAt: Date | null
}

let tmpRoot: string
const tokenRows: TokenRow[] = []
const shellRows: ShellRow[] = []

function resetState() {
  tokenRows.length = 0
  shellRows.length = 0
}

// Minimal drizzle shim: predicates as closures.
vi.mock('drizzle-orm', () => ({
  and:
    (...preds: Array<(r: Record<string, unknown>) => boolean>) =>
    (r: Record<string, unknown>) =>
      preds.every((p) => p(r)),
  eq:
    (col: { _col: string }, val: unknown) =>
    (r: Record<string, unknown>) =>
      r[col._col] === val,
  isNull:
    (col: { _col: string }) =>
    (r: Record<string, unknown>) =>
      r[col._col] === null || r[col._col] === undefined,
  desc: () => ({}),
  sql: () => ({}),
}))

vi.mock('../../db/schema.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    agentShellTokens: {
      tokenHash: { _col: 'tokenHash' },
      sandboxId: { _col: 'sandboxId' },
      issuedAt: { _col: 'issuedAt' },
      revokedAt: { _col: 'revokedAt' },
    },
    shellSessions: {
      id: { _col: 'id' },
      sandboxId: { _col: 'sandboxId' },
      cols: { _col: 'cols' },
      rows: { _col: 'rows' },
    },
  }
})

vi.mock('../../db/client.js', () => ({
  db: {
    insert: (_table: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        if (Array.isArray(v)) return
        if ('tokenHash' in v) {
          tokenRows.push({
            tokenHash: v.tokenHash as string,
            sandboxId: v.sandboxId as string,
            issuedAt: new Date(),
            revokedAt: null,
          })
        } else if ('id' in v) {
          shellRows.push({
            id: v.id as string,
            sandboxId: v.sandboxId as string,
            cwd: (v.cwd as string) ?? '/workspace',
            cols: v.cols as number,
            rows: v.rows as number,
            ownerKind: (v.ownerKind as 'human' | 'agent') ?? 'human',
            ownerSessionId: (v.ownerSessionId as string | null) ?? null,
            createdAt: new Date(),
            lastActivityAt: new Date(),
          })
        }
      },
    }),
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => ({
          limit: async (_n: number) => {
            const isTokens = tokenRows.length && matchesTable(pred, 'token')
            if (isTokens === true) {
              return tokenRows.filter((r) => pred(r as unknown as Record<string, unknown>))
            }
            return shellRows.filter((r) => pred(r as unknown as Record<string, unknown>))
          },
        }),
        limit: async (_n: number) => [],
      }),
    }),
    update: (_t: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async (pred: (r: Record<string, unknown>) => boolean) => {
          for (const r of tokenRows) if (pred(r as unknown as Record<string, unknown>)) Object.assign(r, vals)
          for (const r of shellRows) if (pred(r as unknown as Record<string, unknown>)) Object.assign(r, vals)
        },
      }),
    }),
    delete: (_t: unknown) => ({
      where: async (pred: (r: Record<string, unknown>) => boolean) => {
        for (let i = shellRows.length - 1; i >= 0; i--) {
          if (pred(shellRows[i] as unknown as Record<string, unknown>)) shellRows.splice(i, 1)
        }
      },
    }),
  },
}))

/** Peek at the predicate to decide which table it was built from. */
function matchesTable(pred: unknown, kind: 'token' | 'shell'): boolean {
  // Heuristic: tokenRows have tokenHash; shellRows don't. Try both.
  const sample =
    kind === 'token'
      ? { tokenHash: 'anything', revokedAt: null, sandboxId: '' }
      : { id: 'anything', sandboxId: '' }
  try {
    ;(pred as (r: Record<string, unknown>) => boolean)(sample)
    return true
  } catch {
    return false
  }
}

vi.mock('../../sandbox/manager.js', () => ({
  sandboxManager: {
    get: async (id: string) => ({
      id,
      name: 'sb',
      status: 'active' as const,
      containerId: 'container-fake',
      createdAt: new Date(),
      archivedAt: null,
      running: true,
      workspacePath: '/tmp',
    }),
    onEvent: () => () => {},
  },
}))

vi.mock('node:child_process', async () => {
  const actual = (await vi.importActual(
    'node:child_process',
  )) as typeof import('node:child_process')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events')
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      const child = new EE() as InstanceType<typeof EE> & {
        stdout: InstanceType<typeof EE>
        stderr: InstanceType<typeof EE>
        kill: (sig?: string) => void
      }
      child.stdout = new EE()
      child.stderr = new EE()
      child.kill = () => child.emit('exit', null, 'SIGKILL')
      // Extract the bash -lc "<cmd>" payload so tests can drive different scripts.
      const cmd = args.at(-1) ?? ''
      queueMicrotask(() => {
        if (cmd.startsWith('echo-out:')) {
          child.stdout.emit('data', Buffer.from(cmd.slice('echo-out:'.length)))
          child.emit('exit', 0, null)
        } else if (cmd === 'fail') {
          child.stderr.emit('data', Buffer.from('boom'))
          child.emit('exit', 2, null)
        } else if (cmd === 'sleep-forever') {
          // Don't exit; lets tests exercise abort.
        } else {
          child.emit('exit', 0, null)
        }
      })
      return child
    },
  }
})

// node-pty is only touched by `terminalService.create` (used by `open`). We
// replace it with a fake pty that just echoes writes and exits on kill.
vi.mock('node-pty', () => ({
  spawn: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter: EE } = require('node:events') as typeof import('node:events')
    const em = new EE()
    const handlers = { data: [] as Array<(s: string) => void>, exit: [] as Array<(r: { exitCode: number }) => void> }
    return {
      onData: (cb: (s: string) => void) => {
        handlers.data.push(cb)
        return { dispose: () => {} }
      },
      onExit: (cb: (r: { exitCode: number }) => void) => {
        handlers.exit.push(cb)
        return { dispose: () => {} }
      },
      write: (s: string) => {
        for (const h of handlers.data) h(`echo:${s}`)
      },
      resize: () => {},
      kill: () => {
        for (const h of handlers.exit) h({ exitCode: 0 })
      },
      __em: em,
    } as unknown as import('node-pty').IPty
  },
}))

async function loadCaller() {
  const { appRouter } = await import('../router.js')
  return appRouter.createCaller
}

function makeCtx(opts: {
  bearer?: string
  cookieSession?: boolean
}) {
  const headers: Record<string, string> = {}
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  return {
    req: { headers } as unknown as import('@trpc/server/adapters/fastify').CreateFastifyContextOptions['req'],
    res: {} as unknown as import('@trpc/server/adapters/fastify').CreateFastifyContextOptions['res'],
    ip: '127.0.0.1',
    session: opts.cookieSession
      ? ({ id: 'sess-1', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), lastSeen: new Date() } as import('../../auth/service.js').Session)
      : null,
  }
}

describe('agentShell router', () => {
  let createCaller: Awaited<ReturnType<typeof loadCaller>>

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-shell-'))
    process.env.DATA_DIR = tmpRoot
    resetState()
    vi.resetModules()
    createCaller = await loadCaller()
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function mintToken(sandboxId: string): Promise<string> {
    const { mintAgentShellToken } = await import('../../agent/token.js')
    const { token } = await mintAgentShellToken(sandboxId)
    return token
  }

  it('rejects calls with no auth', async () => {
    const caller = createCaller(makeCtx({}))
    await expect(
      caller.agentShell.open({ cwd: '/workspace' }),
    ).rejects.toThrow(/bearer token or admin cookie/i)
  })

  it('rejects calls with an invalid bearer', async () => {
    const caller = createCaller(makeCtx({ bearer: 'nope' }))
    await expect(
      caller.agentShell.open({ cwd: '/workspace' }),
    ).rejects.toThrow(/invalid or revoked/i)
  })

  it('rejects calls with a revoked bearer', async () => {
    const token = await mintToken('sb-a')
    const { revokeAgentShellToken } = await import('../../agent/token.js')
    await revokeAgentShellToken(token)
    const caller = createCaller(makeCtx({ bearer: token }))
    await expect(caller.agentShell.open({})).rejects.toThrow(/invalid or revoked/i)
  })

  it('tokens are scoped: sandbox-A token cannot operate on sandbox-B shells', async () => {
    // Mint two tokens. Caller A opens a shell in sb-a. Caller B tries to
    // close it with B's token.
    const tokenA = await mintToken('sb-a')
    const tokenB = await mintToken('sb-b')
    const callerA = createCaller(makeCtx({ bearer: tokenA }))
    const callerB = createCaller(makeCtx({ bearer: tokenB }))

    const { shellId } = await callerA.agentShell.open({})
    await expect(
      callerB.agentShell.close({ shellId }),
    ).rejects.toThrow(/not in this sandbox/i)

    // Explicit cross-sandbox id in input is also rejected before touching
    // the shell table.
    await expect(
      callerA.agentShell.open({ sandboxId: 'sb-b' }),
    ).rejects.toThrow(/scoped to a different sandbox/i)

    // Cleanup.
    await callerA.agentShell.close({ shellId })
  })

  it('open → write → close round-trip; shell is visible in shell.list with owner_kind=agent', async () => {
    const token = await mintToken('sb-a')
    const caller = createCaller(makeCtx({ bearer: token, cookieSession: true }))

    const { shellId } = await caller.agentShell.open({ cwd: '/tmp' })

    // List via the human-facing shell router (cookie path).
    const cookieCaller = createCaller(makeCtx({ cookieSession: true }))
    const list = await cookieCaller.shell.list({ sandboxId: 'sb-a' })
    const row = list.find((s) => s.id === shellId)
    expect(row).toBeDefined()
    expect(row!.ownerKind).toBe('agent')

    // write — fake pty echoes "echo:<data>" back; no assertion here other
    // than it doesn't throw.
    const w = await caller.agentShell.write({
      shellId,
      b64: Buffer.from('ls -la\n').toString('base64'),
    })
    expect(w.ok).toBe(true)

    // close disposes the shell; subsequent write fails.
    const c = await caller.agentShell.close({ shellId })
    expect(c.ok).toBe(true)
    await expect(
      caller.agentShell.write({ shellId, b64: '' }),
    ).rejects.toThrow()
  })

  it('runOnce subscription emits started → stdout → exit', async () => {
    const token = await mintToken('sb-a')
    const caller = createCaller(makeCtx({ bearer: token }))
    const obs = (await caller.agentShell.runOnce({
      cmd: 'echo-out:hello',
    })) as unknown as Observable<Record<string, unknown>, unknown>

    const events: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve, reject) => {
      const sub = obs.subscribe({
        next: (e) => {
          events.push(e)
          if (e.type === 'exit') {
            sub.unsubscribe()
            resolve()
          }
        },
        error: (e) => reject(e),
      })
    })

    expect(events[0]?.type).toBe('started')
    const stdoutEvents = events.filter((e) => e.type === 'stdout')
    expect(stdoutEvents.length).toBeGreaterThanOrEqual(1)
    const decoded = Buffer.from(stdoutEvents[0]!.b64 as string, 'base64').toString('utf8')
    expect(decoded).toBe('hello')
    const exitEvent = events.at(-1)!
    expect(exitEvent.type).toBe('exit')
    expect(exitEvent.code).toBe(0)
  })

  it('runOnce unsubscribe kills the underlying shell within a second', async () => {
    const token = await mintToken('sb-a')
    const caller = createCaller(makeCtx({ bearer: token }))
    const obs = (await caller.agentShell.runOnce({
      cmd: 'sleep-forever',
    })) as unknown as Observable<Record<string, unknown>, unknown>

    let shellId: string | null = null
    let exited = false
    const sub = obs.subscribe({
      next: (e) => {
        if (e.type === 'started') shellId = e.shellId as string
        if (e.type === 'exit') exited = true
      },
      error: () => {},
    })
    // Give the subscribe time to spawn and emit 'started'.
    await new Promise((r) => setTimeout(r, 20))
    expect(shellId).not.toBeNull()
    sub.unsubscribe()
    // Under our stub, kill() emits exit synchronously — wait a tick and then
    // assert the shell is gone from the service.
    await new Promise((r) => setTimeout(r, 30))
    const { terminalService } = await import('../../terminal/service.js')
    expect(terminalService.get(shellId!)).toBeNull()
    // Exit callback in the observable does NOT fire after unsubscribe; we
    // only assert disposal. `exited` may be false.
    void exited
  })

  it('tail returns base64 snapshot + exitCode after a run-once exits', async () => {
    const token = await mintToken('sb-a')
    const caller = createCaller(makeCtx({ bearer: token }))
    const { terminalService } = await import('../../terminal/service.js')
    terminalService.__setRunOnceRetentionMs(60_000)
    const obs = (await caller.agentShell.runOnce({
      cmd: 'echo-out:tail-me',
    })) as unknown as Observable<Record<string, unknown>, unknown>
    const events: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve, reject) => {
      const sub = obs.subscribe({
        next: (e) => {
          events.push(e)
          if (e.type === 'exit') {
            sub.unsubscribe()
            resolve()
          }
        },
        error: reject,
      })
    })
    const started = events.find((e) => e.type === 'started')!
    const shellId = started.shellId as string
    const t = await caller.agentShell.tail({ shellId })
    expect(t.exitCode).toBe(0)
    const decoded = Buffer.from(t.b64, 'base64').toString('utf8')
    expect(decoded).toContain('tail-me')
  })

  it('tail can wait for minBytes before returning', async () => {
    const token = await mintToken('sb-a')
    const caller = createCaller(makeCtx({ bearer: token }))
    const { shellId } = await caller.agentShell.open({})

    const pending = caller.agentShell.tail({ shellId, minBytes: 5, timeoutMs: 1_000 })
    setTimeout(() => {
      void caller.agentShell.write({ shellId, b64: Buffer.from('ready\n').toString('base64') })
    }, 10)

    const t = await pending
    expect(t.timedOut).toBe(false)
    expect(t.newBytes).toBeGreaterThanOrEqual(5)
    const decoded = Buffer.from(t.b64, 'base64').toString('utf8')
    expect(decoded).toContain('echo:ready')
  })

  it('tail reports current output when minBytes timeout elapses', async () => {
    const token = await mintToken('sb-a')
    const caller = createCaller(makeCtx({ bearer: token }))
    const { shellId } = await caller.agentShell.open({})

    const t = await caller.agentShell.tail({ shellId, minBytes: 5, timeoutMs: 20 })

    expect(t.timedOut).toBe(true)
    expect(t.newBytes).toBe(0)
    expect(t.alive).toBe(true)
  })
})
