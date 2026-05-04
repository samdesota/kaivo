import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type AgentRow = {
  id: string
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
let loginShellEnv: NodeJS.ProcessEnv = {}

function resetState() {
  agentRows.length = 0
  shellRows.length = 0
  spawnedCwds.length = 0
  spawnedEnvs.length = 0
  runOnceSpawnedEnvs.length = 0
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
      write: (data: string) => em.emit('data', data),
      resize: () => undefined,
      kill: () => em.emit('exit', { exitCode: 0 }),
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
  resetState()
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('terminal service workspace shells', () => {
  it('shell create records workspace, cwd, and owner agent session', async () => {
    agentRows.push({ id: 'agent-a', opencodeSessionId: 'oc-a', workingDir: '/tmp/project-a' })
    const { terminalService } = await import('./service.js')

    const shell = await terminalService.create({
      workspaceId: 'workspace-a',
      ownerAgentSessionId: 'agent-a',
      ownerKind: 'agent',
    })

    expect(shell).toMatchObject({
      workspaceId: 'workspace-a',
      cwd: '/tmp/project-a',
      ownerAgentSessionId: 'agent-a',
      ownerKind: 'agent',
    })
    expect(spawnedCwds).toEqual(['/tmp/project-a'])
    expect(shellRows[0]).toMatchObject({
      workspaceId: 'workspace-a',
      cwd: '/tmp/project-a',
      ownerAgentSessionId: 'agent-a',
    })
  })

  it('shell list filters by workspace and does not mix sessions', async () => {
    const { terminalService } = await import('./service.js')

    await terminalService.create({ workspaceId: 'workspace-a', cwd: '/tmp/a' })
    await terminalService.create({ workspaceId: 'workspace-b', cwd: '/tmp/b' })
    await terminalService.create({ cwd: '/tmp/legacy' })

    expect(terminalService.list({ workspaceId: 'workspace-a' }).map((s) => s.cwd)).toEqual(['/tmp/a'])
    expect(terminalService.list()).toHaveLength(3)
  })

  it('uses login shell env for persistent shells instead of server runtime env', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CC_IDENTITY_URL', 'http://127.0.0.1:3100')
    vi.stubEnv('CC_WORKING_DIR', '/internal/workspace')
    vi.stubEnv('PATH', '/server/bin')
    const { terminalService } = await import('./service.js')

    await terminalService.create({ cwd: '/tmp/project' })

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

    const handle = terminalService.runOnceStream({ cmd: 'echo hi', cwd: '/tmp/project' })
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
})
