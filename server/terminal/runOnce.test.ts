import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for TerminalService.runOnce that don't need Docker. We stub
 * child_process.spawn with a fake process emitting stdout/stderr/exit events
 * and stub sandboxManager.get to return a "running" sandbox.
 */

describe('TerminalService.runOnce', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'term-svc-'))
    process.env.DATA_DIR = tmpRoot
    vi.resetModules()
  })
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function stub(output: {
    stdoutChunks?: Buffer[]
    stderrChunks?: Buffer[]
    exitCode?: number
    delayMs?: number
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

    vi.doMock('node:child_process', async () => {
      const actual = (await vi.importActual('node:child_process')) as typeof import('node:child_process')
      return {
        ...actual,
        spawn: () => makeFakeChild(output),
      }
    })
  }

  function makeFakeChild(o: {
    stdoutChunks?: Buffer[]
    stderrChunks?: Buffer[]
    exitCode?: number
    delayMs?: number
  }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter: EE } = require('node:events') as typeof import('node:events')
    const child = new EE() as InstanceType<typeof EE> & {
      stdout: InstanceType<typeof EE>
      stderr: InstanceType<typeof EE>
      kill: () => void
    }
    child.stdout = new EE()
    child.stderr = new EE()
    child.kill = () => child.emit('exit', null, 'SIGKILL')

    queueMicrotask(() => {
      for (const c of o.stdoutChunks ?? []) child.stdout.emit('data', c)
      for (const c of o.stderrChunks ?? []) child.stderr.emit('data', c)
      if (o.delayMs && o.delayMs > 0) {
        setTimeout(() => child.emit('exit', o.exitCode ?? 0, null), o.delayMs)
      } else {
        child.emit('exit', o.exitCode ?? 0, null)
      }
    })
    return child
  }

  it('returns stdout + exitCode on success', async () => {
    await stub({ stdoutChunks: [Buffer.from('hi\n')], exitCode: 0 })
    const { terminalService } = await import('./service.js')
    const r = await terminalService.runOnce({
      sandboxId: 'sb-fake',
      cmd: 'echo hi',
    })
    expect(r.stdout).toBe('hi\n')
    expect(r.exitCode).toBe(0)
    expect(r.truncated).toBe(false)
  })

  it('propagates a non-zero exit code', async () => {
    await stub({ stdoutChunks: [], exitCode: 42 })
    const { terminalService } = await import('./service.js')
    const r = await terminalService.runOnce({ sandboxId: 'sb-fake', cmd: 'exit 42' })
    expect(r.exitCode).toBe(42)
  })

  it('truncates output past 10MB', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61) // 11 MB
    await stub({ stdoutChunks: [big], exitCode: 0 })
    const { terminalService } = await import('./service.js')
    const r = await terminalService.runOnce({ sandboxId: 'sb-fake', cmd: 'big' })
    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024)
  })

  it('times out long-running commands', async () => {
    await stub({ stdoutChunks: [], delayMs: 5000, exitCode: 0 })
    const { terminalService, ShellError } = await import('./service.js')
    await expect(
      terminalService.runOnce({ sandboxId: 'sb-fake', cmd: 'sleep 5', timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(ShellError)
  })
})
