import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type AgentRow = {
  id: string
  workspaceId: string | null
  opencodeSessionId: string
  workingDir: string | null
}

type ShellRow = {
  id: string
  workspaceId: string | null
  cwd: string
  cols: number
  rows: number
  ownerKind: 'human' | 'agent'
  ownerAgentSessionId: string | null
  ownerSessionId: string | null
  createdAt: string
  lastActivityAt: string
}

const agentRows: AgentRow[] = []
const shellRows: ShellRow[] = []
const spawnedCwds: string[] = []
const spawnedEnvs: Array<NodeJS.ProcessEnv | undefined> = []
const runOnceSpawnedEnvs: Array<NodeJS.ProcessEnv | undefined> = []
const ptyWrites: string[] = []
const ptyKills: Array<string | undefined> = []
let loginShellEnv: NodeJS.ProcessEnv = {}
let tempRoot = ''

function resetState() {
  agentRows.length = 0
  shellRows.length = 0
  spawnedCwds.length = 0
  spawnedEnvs.length = 0
  runOnceSpawnedEnvs.length = 0
  ptyWrites.length = 0
  ptyKills.length = 0
  loginShellEnv = { HOME: '/Users/tester', PATH: '/login/bin:/usr/bin', SHELL: '/bin/zsh', USER: 'tester' }
}

vi.mock('drizzle-orm', () => ({
  eq:
    (col: { _col: string }, val: unknown) =>
    (r: Record<string, unknown>) =>
      r[col._col] === val,
}))

vi.mock('../config.js', () => ({
  config: { CC_WORKING_DIR: '/workspace' },
}))

vi.mock('../db/schema.js', () => ({
  agentSessions: {
    _table: 'agent_sessions',
    id: { _col: 'id' },
    workspaceId: { _col: 'workspaceId' },
    opencodeSessionId: { _col: 'opencodeSessionId' },
    workingDir: { _col: 'workingDir' },
  },
  shellSessions: {
    _table: 'shell_sessions',
    id: { _col: 'id' },
    workspaceId: { _col: 'workspaceId' },
    cwd: { _col: 'cwd' },
    cols: { _col: 'cols' },
    rows: { _col: 'rows' },
    ownerKind: { _col: 'ownerKind' },
    ownerAgentSessionId: { _col: 'ownerAgentSessionId' },
    ownerSessionId: { _col: 'ownerSessionId' },
    createdAt: { _col: 'createdAt' },
    lastActivityAt: { _col: 'lastActivityAt' },
  },
}))

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: (table: { _table: string }) => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => ({
          limit: () => ({
            all: () => {
              const rows = table._table === 'agent_sessions' ? agentRows : shellRows
              return (rows as unknown as Record<string, unknown>[]).filter(pred)
            },
          }),
        }),
      }),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        run: () => shellRows.push(value as ShellRow),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => ({
          run: () => {
            for (const row of shellRows) {
              if (pred(row as unknown as Record<string, unknown>)) Object.assign(row, values)
            }
          },
        }),
      }),
    }),
    delete: () => ({
      where: (pred: (r: Record<string, unknown>) => boolean) => ({
        run: () => {
          for (let i = shellRows.length - 1; i >= 0; i--) {
            if (pred(shellRows[i] as unknown as Record<string, unknown>)) shellRows.splice(i, 1)
          }
        },
      }),
    }),
  },
}))

vi.mock('node-pty', () => ({
  spawn: (_shell: string, _args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
    spawnedCwds.push(opts.cwd)
    spawnedEnvs.push(opts.env)
    const em = new EventEmitter()
    return {
      onData: (cb: (s: string) => void) => {
        em.on('data', cb)
        return { dispose: () => em.off('data', cb) }
      },
      onExit: (cb: (r: { exitCode: number }) => void) => {
        em.on('exit', cb)
        return { dispose: () => em.off('exit', cb) }
      },
      write: (data: string) => {
        ptyWrites.push(data)
        em.emit('data', data)
      },
      resize: () => undefined,
      kill: (signal?: string) => {
        ptyKills.push(signal)
        em.emit('exit', { exitCode: 0 })
      },
    }
  },
}))

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    if (args[0] === '-ilc') {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from(
            `_CLOUD_CODE_SHELL_ENV_DELIMITER_${Object.entries(loginShellEnv)
              .map(([key, value]) => `${key}=${value}`)
              .join('\n')}\n_CLOUD_CODE_SHELL_ENV_DELIMITER_`,
          ),
        )
        child.emit('exit', 0, null)
      })
      return child
    }

    runOnceSpawnedEnvs.push(opts.env)
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {
      child.emit('exit', 130, null)
      return true
    }
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  },
}))

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-service-test-'))
  resetState()
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
})

function tempDir(name: string) {
  const dir = path.join(tempRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('terminal service workspace shells', () => {
  it('shell create records workspace, cwd, and owner agent session', async () => {
    const projectA = tempDir('project-a')
    agentRows.push({ id: 'agent-a', workspaceId: 'workspace-a', opencodeSessionId: 'oc-a', workingDir: projectA })
    const { terminalService } = await import('./service.js')

    const shell = await terminalService.create({
      workspaceId: 'workspace-a',
      ownerAgentSessionId: 'agent-a',
      ownerKind: 'agent',
    })

    expect(shell).toMatchObject({
      workspaceId: 'workspace-a',
      cwd: projectA,
      ownerAgentSessionId: 'agent-a',
      ownerKind: 'agent',
    })
    expect(spawnedCwds).toEqual([projectA])
    expect(shellRows[0]).toMatchObject({
      workspaceId: 'workspace-a',
      cwd: projectA,
      ownerAgentSessionId: 'agent-a',
    })
  })

  it('infers workspace from opencode session for agent shells', async () => {
    const projectA = tempDir('project-a')
    agentRows.push({ id: 'agent-a', workspaceId: 'workspace-a', opencodeSessionId: 'oc-a', workingDir: projectA })
    const { terminalService } = await import('./service.js')

    const shell = await terminalService.create({ ownerKind: 'agent', ownerSessionId: 'oc-a' })

    expect(shell.workspaceId).toBe('workspace-a')
    expect(terminalService.list({ workspaceId: 'workspace-a' }).map((s) => s.id)).toEqual([shell.id])
    expect(shellRows[0]?.workspaceId).toBe('workspace-a')
  })

  it('shell list filters by workspace and does not mix sessions', async () => {
    const { terminalService } = await import('./service.js')

    const workspaceA = tempDir('a')
    const workspaceB = tempDir('b')
    const legacy = tempDir('legacy')
    await terminalService.create({ workspaceId: 'workspace-a', cwd: workspaceA })
    await terminalService.create({ workspaceId: 'workspace-b', cwd: workspaceB })
    await terminalService.create({ cwd: legacy })

    expect(terminalService.list({ workspaceId: 'workspace-a' }).map((s) => s.cwd)).toEqual([workspaceA])
    expect(terminalService.list()).toHaveLength(3)
  })

  it('uses login shell env for persistent shells instead of server runtime env', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CC_IDENTITY_URL', 'http://127.0.0.1:3100')
    vi.stubEnv('CC_WORKING_DIR', '/internal/workspace')
    vi.stubEnv('PATH', '/server/bin')
    const { terminalService } = await import('./service.js')

    await terminalService.create({ cwd: tempDir('project') })

    expect(spawnedEnvs[0]).toMatchObject({
      HOME: '/Users/tester',
      PATH: '/login/bin:/usr/bin',
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
    })
    expect(spawnedEnvs[0]).not.toHaveProperty('NODE_ENV')
    expect(spawnedEnvs[0]).not.toHaveProperty('CC_IDENTITY_URL')
    expect(spawnedEnvs[0]).not.toHaveProperty('CC_WORKING_DIR')
  })

  it('uses login shell env for run-once shells instead of server runtime env', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CC_IDENTITY_URL', 'http://127.0.0.1:3100')
    vi.stubEnv('CC_WORKING_DIR', '/internal/workspace')
    vi.stubEnv('PATH', '/server/bin')
    const { terminalService } = await import('./service.js')

    const handle = terminalService.runOnceStream({ cmd: 'echo hi', cwd: tempDir('project') })
    await handle.exitPromise

    expect(runOnceSpawnedEnvs[0]).toMatchObject({
      HOME: '/Users/tester',
      PATH: '/login/bin:/usr/bin',
      SHELL: '/bin/zsh',
    })
    expect(runOnceSpawnedEnvs[0]).not.toHaveProperty('NODE_ENV')
    expect(runOnceSpawnedEnvs[0]).not.toHaveProperty('CC_IDENTITY_URL')
    expect(runOnceSpawnedEnvs[0]).not.toHaveProperty('CC_WORKING_DIR')
  })

  it('interrupts a persistent foreground job before force-closing its PTY', async () => {
    vi.useFakeTimers()
    try {
      const { terminalService } = await import('./service.js')
      const shell = await terminalService.create({ cwd: tempDir('project') })

      terminalService.dispose(shell.id)

      expect(terminalService.get(shell.id)).toBeNull()
      expect(ptyWrites).toEqual(['\x03'])
      expect(ptyKills).toEqual([])

      await vi.advanceTimersByTimeAsync(9_999)
      expect(ptyKills).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(ptyKills).toEqual(['SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })
})
