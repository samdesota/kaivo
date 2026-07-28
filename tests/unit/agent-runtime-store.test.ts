import { describe, expect, it, vi } from 'vitest'
import { applyAgentRuntimeChangeEvents } from '../../src/routes/workspace/agent-runtime-store'

describe('agent runtime store', () => {
  it('keeps the cursor at the newest event when a batch updates one session more than once', () => {
    const collectionUtils = {
      writeBatch: vi.fn((callback: () => void) => callback()),
      writeUpsert: vi.fn(),
      writeDelete: vi.fn(),
    }
    const row = (sessionId: string, running: boolean) => ({
      sessionId,
      workspaceId: 'workspace-a',
      running,
      pendingAttentionCount: 0,
      lastActivityAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z',
    })

    const seq = applyAgentRuntimeChangeEvents({
      syncedSeq: 0,
      collectionUtils: collectionUtils as never,
      collectionHas: () => true,
      events: [
        { seq: 1, table: 'agent_session_runtime', op: 'insert', key: 'session-a', row: row('session-a', true) },
        { seq: 2, table: 'agent_session_runtime', op: 'insert', key: 'session-b', row: row('session-b', true) },
        { seq: 3, table: 'agent_session_runtime', op: 'update', key: 'session-a', row: row('session-a', false) },
      ],
    })

    expect(seq).toBe(3)
    expect(collectionUtils.writeUpsert).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a', running: false }))
  })
})
