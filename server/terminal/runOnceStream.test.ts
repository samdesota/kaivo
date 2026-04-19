import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for TerminalService.runOnceStream. We stub sandboxManager to
 * report a "running" sandbox and fake `child_process.spawn` with an
 * EventEmitter that emits data, then exit. Drizzle inserts are stubbed at
 * the `db` boundary so the test doesn't need Postgres.
 */

describe('TerminalService.runOnceStream', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'term-stream-'))
    process.env.DATA_DIR = tmpRoot
    vi.resetModules()
  })
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function setup(output: {
    stdoutChunks?: Array<Buffer | { after: number; data: Buffer }>
    stderrChunks?: Array<Buffer | { after: number; data: Buffer }>
    exitCode?: number
    exitAfterMs?: number
  }) {
    vi.doMock('../sandbox/manager.js', () => {
      return {
        sandboxManager: {
          get: async () => ({
            id: 'sb-fake',
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
      }
    })

    vi.doMock('../db/client.js', () => ({
      db: {
        insert: () => ({ values: async () => undefined }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
        delete: () => ({ where: () => Promise.resolve(undefined) }),
      },
    }))

    vi.doMock('node:child_process', async () => {
      const actual = (await vi.importActual(
        'node:child_process',
      )) as typeof import('node:child_process')
      return { ...actual, spawn: () => makeFakeChild(output) }
    })
  }

  function makeFakeChild(o: {
    stdoutChunks?: Array<Buffer | { after: number; data: Buffer }>
    stderrChunks?: Array<Buffer | { after: number; data: Buffer }>
    exitCode?: number
    exitAfterMs?: number
  }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter: EE } = require('node:events') as typeof import('node:events')
    const child = new EE() as InstanceType<typeof EE> & {
      stdout: InstanceType<typeof EE>
      stderr: InstanceType<typeof EE>
      kill: (sig?: string) => void
    }
    child.stdout = new EE()
    child.stderr = new EE()
    child.kill = () => child.emit('exit', null, 'SIGKILL')

    queueMicrotask(() => {
      for (const c of o.stdoutChunks ?? []) {
        if (Buffer.isBuffer(c)) child.stdout.emit('data', c)
        else setTimeout(() => child.stdout.emit('data', c.data), c.after)
      }
      for (const c of o.stderrChunks ?? []) {
        if (Buffer.isBuffer(c)) child.stderr.emit('data', c)
        else setTimeout(() => child.stderr.emit('data', c.data), c.after)
      }
      if (o.exitAfterMs && o.exitAfterMs > 0) {
        setTimeout(() => child.emit('exit', o.exitCode ?? 0, null), o.exitAfterMs)
      } else {
        child.emit('exit', o.exitCode ?? 0, null)
      }
    })
    return child
  }

  it('returns a shellId synchronously and exits with the expected code', async () => {
    await setup({ stdoutChunks: [Buffer.from('hi\n')], exitCode: 0 })
    const { terminalService } = await import('./service.js')
    const handle = terminalService.runOnceStream({
      sandboxId: 'sb-fake',
      cmd: 'echo hi',
    })
    expect(typeof handle.shellId).toBe('string')
    expect(handle.shellId.length).toBeGreaterThan(0)
    const r = await handle.exitPromise
    expect(r.exitCode).toBe(0)
    expect(r.truncated).toBe(false)
  })

  it('invokes onStdout/onStderr callbacks as bytes arrive', async () => {
    await setup({
      stdoutChunks: [Buffer.from('out1'), Buffer.from('out2')],
      stderrChunks: [Buffer.from('err1')],
      exitCode: 0,
    })
    const { terminalService } = await import('./service.js')
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const handle = terminalService.runOnceStream({
      sandboxId: 'sb-fake',
      cmd: 'two-chunks',
      onStdout: (c) => stdout.push(c),
      onStderr: (c) => stderr.push(c),
    })
    await handle.exitPromise
    expect(Buffer.concat(stdout).toString()).toBe('out1out2')
    expect(Buffer.concat(stderr).toString()).toBe('err1')
  })

  it('attach() sees a snapshot of already-written output', async () => {
    await setup({ stdoutChunks: [Buffer.from('hello world\n')], exitCode: 0 })
    const { terminalService } = await import('./service.js')
    terminalService.__setRunOnceRetentionMs(60_000)
    const handle = terminalService.runOnceStream({
      sandboxId: 'sb-fake',
      cmd: 'echo hello world',
    })
    await handle.exitPromise
    // Attach after exit — should get the buffered snapshot.
    const chunks: string[] = []
    const attached = terminalService.attach(handle.shellId, (c) => chunks.push(c))
    expect(attached).not.toBeNull()
    expect(attached!.snapshot).toContain('hello world')
    attached!.unsubscribe()
    await handle.dispose()
  })

  it('late live-attach receives chunks pushed after attach time', async () => {
    await setup({
      stdoutChunks: [
        Buffer.from('first\n'),
        { after: 40, data: Buffer.from('second\n') },
      ],
      exitAfterMs: 80,
      exitCode: 0,
    })
    const { terminalService } = await import('./service.js')
    terminalService.__setRunOnceRetentionMs(60_000)
    const handle = terminalService.runOnceStream({
      sandboxId: 'sb-fake',
      cmd: 'two-chunks-spaced',
    })

    // Give the first chunk time to be written.
    await new Promise((r) => setTimeout(r, 10))
    const live: string[] = []
    const attached = terminalService.attach(handle.shellId, (c) => live.push(c))
    expect(attached).not.toBeNull()
    // Snapshot contains first chunk.
    expect(attached!.snapshot).toContain('first')
    // Live subscriber picks up the second chunk (streamed, not one burst).
    await handle.exitPromise
    expect(live.join('')).toContain('second')
    attached!.unsubscribe()
    await handle.dispose()
  })

  it('retains the shell after exit, then disposes after retentionMs', async () => {
    await setup({ stdoutChunks: [Buffer.from('bye\n')], exitCode: 0 })
    const { terminalService } = await import('./service.js')
    terminalService.__setRunOnceRetentionMs(50)

    const handle = terminalService.runOnceStream({
      sandboxId: 'sb-fake',
      cmd: 'echo bye',
    })
    await handle.exitPromise
    // Still attachable right after exit.
    expect(terminalService.attach(handle.shellId, () => {})).not.toBeNull()
    // Wait past retention.
    await new Promise((r) => setTimeout(r, 80))
    expect(terminalService.attach(handle.shellId, () => {})).toBeNull()
  })

  it('run-once shells do not appear in listBySandbox', async () => {
    await setup({ stdoutChunks: [Buffer.from('x')], exitCode: 0 })
    const { terminalService } = await import('./service.js')
    terminalService.__setRunOnceRetentionMs(60_000)
    const handle = terminalService.runOnceStream({
      sandboxId: 'sb-fake',
      cmd: 'echo x',
    })
    await handle.exitPromise
    const visible = terminalService.listBySandbox('sb-fake')
    expect(visible.find((s) => s.id === handle.shellId)).toBeUndefined()
    await handle.dispose()
  })

  it('dispose() before exit kills the child', async () => {
    await setup({ exitAfterMs: 5_000, exitCode: 0 })
    const { terminalService } = await import('./service.js')
    const handle = terminalService.runOnceStream({
      sandboxId: 'sb-fake',
      cmd: 'sleep 5',
    })
    // Give the spawn microtask a chance to wire up.
    await new Promise((r) => setTimeout(r, 5))
    await handle.dispose()
    const r = await handle.exitPromise
    // Fake child's kill() emits exit with code=null, signal='SIGKILL'; service
    // maps that to exitCode 128.
    expect(r.exitCode).toBe(128)
  })

  it('propagates AbortSignal to kill the child', async () => {
    await setup({ exitAfterMs: 5_000, exitCode: 0 })
    const { terminalService } = await import('./service.js')
    const ac = new AbortController()
    const handle = terminalService.runOnceStream({
      sandboxId: 'sb-fake',
      cmd: 'sleep 5',
      signal: ac.signal,
    })
    await new Promise((r) => setTimeout(r, 5))
    ac.abort()
    const r = await handle.exitPromise
    expect(r.exitCode).toBe(128)
    await handle.dispose()
  })
})
