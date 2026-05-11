import { describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_RUNTIME_TABLE, getAgentRuntimeRealtime } from '../../agent/runtime-realtime.js'

vi.mock('../../envmeta/service.js', () => ({
  isPaired: () => true,
  hashEnvToken: () => 'hash',
  hasEnvTokenHash: () => true,
}))

vi.mock('../../agent/opencode.js', () => ({
  opencodeSupervisor: { verifyAgentShellToken: () => false },
}))

vi.mock('../../config.js', () => ({
  config: { CC_KIND: 'local' },
}))

function makeCtx() {
  return {
    req: { headers: {} } as never,
    res: {} as never,
    envTokenPresent: true,
    agentShellTokenPresent: false,
  }
}

describe('agentRuntime router', () => {
  it('exposes workspace-filtered runtime snapshots', async () => {
    const { agentRuntimeRouter } = await import('./agent-runtime.js')
    const realtime = getAgentRuntimeRealtime()
    realtime.upsert(AGENT_SESSION_RUNTIME_TABLE, {
      sessionId: 'session-a',
      workspaceId: 'workspace-a',
      running: true,
      pendingAttentionCount: 0,
      lastActivityAt: '2026-05-10T12:00:00.000Z',
      updatedAt: '2026-05-10T12:00:00.000Z',
    })
    realtime.upsert(AGENT_SESSION_RUNTIME_TABLE, {
      sessionId: 'session-b',
      workspaceId: 'workspace-b',
      running: false,
      pendingAttentionCount: 1,
      lastActivityAt: '2026-05-10T12:01:00.000Z',
      updatedAt: '2026-05-10T12:01:00.000Z',
    })

    const caller = agentRuntimeRouter.createCaller(makeCtx())
    await expect(caller.snapshot({ workspaceId: 'workspace-a' })).resolves.toMatchObject({
      table: AGENT_SESSION_RUNTIME_TABLE,
      rows: [expect.objectContaining({ sessionId: 'session-a', running: true })],
    })
  })
})
