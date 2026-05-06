import { beforeEach, describe, expect, it, vi } from 'vitest'

type AgentSessionRow = {
  id: string
  workspaceId: string | null
  opencodeSessionId: string
  workingDir: string | null
}

const agentRows: AgentSessionRow[] = []
const openPaneMock = vi.hoisted(() => vi.fn())

vi.mock('drizzle-orm', () => ({
  eq:
    (col: { _col: string }, val: unknown) =>
    (row: Record<string, unknown>) =>
      row[col._col] === val,
}))

vi.mock('../../config.js', () => ({
  config: {
    CC_WORKING_DIR: '/workspace',
    CC_INSTANCE_ID: 'default',
  },
}))

vi.mock('../../db/schema.js', () => ({
  agentSessions: {
    id: { _col: 'id' },
    workspaceId: { _col: 'workspaceId' },
    opencodeSessionId: { _col: 'opencodeSessionId' },
    workingDir: { _col: 'workingDir' },
  },
}))

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (pred: (row: Record<string, unknown>) => boolean) => ({
          limit: (n: number) => ({ all: () => agentRows.filter((row) => pred(row as unknown as Record<string, unknown>)).slice(0, n) }),
        }),
      }),
    }),
  },
}))

vi.mock('../../identity/client.js', () => ({
  openPane: openPaneMock,
}))

vi.mock('../../terminal/service.js', () => ({
  terminalService: {
    get: () => ({ id: 'shell-1', alive: true }),
  },
}))

vi.mock('../../envmeta/service.js', () => ({
  isPaired: () => true,
  hashEnvToken: () => 'hash',
  hasEnvTokenHash: () => true,
}))

vi.mock('../../agent/opencode.js', () => ({
  opencodeSupervisor: { verifyAgentShellToken: () => true },
}))

function makeCtx() {
  return {
    req: { headers: {} } as never,
    res: {} as never,
    envTokenPresent: false,
    agentShellTokenPresent: true,
  }
}

beforeEach(() => {
  agentRows.length = 0
  openPaneMock.mockReset()
  openPaneMock.mockResolvedValue({ ok: true })
})

describe('agentUi.openPane', () => {
  it('persists a pane without requiring a frontend subscriber', async () => {
    const { agentUiRouter } = await import('./agent-ui.js')
    agentRows.push({ id: 'agent-1', workspaceId: 'workspace-1', opencodeSessionId: 'oc-1', workingDir: '/workspace/subdir' })
    const caller = agentUiRouter.createCaller(makeCtx())

    await expect(caller.openPane({
      opencodeSessionId: 'oc-1',
      content: { type: 'preview', port: 5173 },
    })).resolves.toEqual({ ok: true })

    expect(openPaneMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      envId: 'local-default',
      content: { type: 'preview', port: 5173 },
      title: undefined,
      activate: undefined,
    })
  })

  it('resolves relative file paths against the agent working directory before persisting', async () => {
    const { agentUiRouter } = await import('./agent-ui.js')
    agentRows.push({ id: 'agent-1', workspaceId: 'workspace-1', opencodeSessionId: 'oc-1', workingDir: '/workspace/subdir' })
    const caller = agentUiRouter.createCaller(makeCtx())

    await caller.openPane({
      opencodeSessionId: 'oc-1',
      content: { type: 'file', path: 'src/app.ts' },
      activate: false,
    })

    expect(openPaneMock).toHaveBeenCalledWith(expect.objectContaining({
      content: { type: 'file', path: '/workspace/subdir/src/app.ts', absolute: true },
      activate: false,
    }))
  })

  it('returns a clear error when the agent session is not attached to a workspace', async () => {
    const { agentUiRouter } = await import('./agent-ui.js')
    agentRows.push({ id: 'agent-1', workspaceId: null, opencodeSessionId: 'oc-1', workingDir: '/workspace' })
    const caller = agentUiRouter.createCaller(makeCtx())

    await expect(caller.openPane({
      opencodeSessionId: 'oc-1',
      content: { type: 'preview', port: 5173 },
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(openPaneMock).not.toHaveBeenCalled()
  })
})
