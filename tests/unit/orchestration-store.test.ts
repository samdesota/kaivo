import { describe, expect, it, vi } from 'vitest'
import {
  formatAggregateDetail,
  orchestrationAggregates,
  orchestrationRecovery,
  normalizeOrchestrationSnapshot,
  relevantOrchestrationSessionIds,
  resolveOrchestrationSelection,
  OrchestrationReplayState,
  provisioningStageLabel,
  readOrchestrationSelection,
  replaceOrchestrationSubtask,
  writeOrchestrationSelection,
} from '../../src/routes/env/agent/orchestration-store'

describe('orchestration client store', () => {
  it('orders reconnect changes and replaces stale or gapped snapshots', () => {
    const store = new OrchestrationReplayState()
    store.replace({ generation: 'a', seq: 4 })
    expect(store.accept({ type: 'changed', cursor: { generation: 'a', seq: 4 } })).toBe('ignore')
    expect(store.accept({ type: 'changed', cursor: { generation: 'a', seq: 5 } })).toBe('refresh')
    expect(store.accept({ type: 'changed', cursor: { generation: 'a', seq: 7 } })).toBe('replace')
    expect(store.accept({ type: 'stale', cursor: { generation: 'b', seq: 1 } })).toBe('replace')
    expect(store.accept({ type: 'changed', cursor: { generation: 'b', seq: 2 } })).toBe('refresh')
  })

  it('derives runtime and lifecycle aggregates without changing task ordering', () => {
    const tasks = [
      { state: 'returned' as const, running: false, pendingAttentionCount: 0 },
      { state: 'active' as const, running: true, pendingAttentionCount: 2 },
      { state: 'failed' as const, running: false, pendingAttentionCount: 0 },
    ]
    expect(orchestrationAggregates(tasks)).toEqual({ running: 1, returned: 1, attention: 1, failed: 1, completed: 0 })
    expect(formatAggregateDetail(tasks)).toBe('1 running · 1 returned · 1 attention · 1 failed')
  })

  it('replaces a completed subtask without disturbing hierarchy order', () => {
    const snapshot = { cursor: { generation: 'a', seq: 1 }, dispatches: [{ id: 'dispatch', subtasks: [{ id: 'one', state: 'active' }, { id: 'two', state: 'returned' }] }] }
    const next = replaceOrchestrationSubtask(snapshot, { id: 'two', state: 'completed', completedAt: '2026-07-21T00:00:00Z' })
    expect(next?.dispatches[0]?.subtasks).toEqual([
      { id: 'one', state: 'active' },
      { id: 'two', state: 'completed', completedAt: '2026-07-21T00:00:00Z' },
    ])
  })

  it('projects typed progress, retry, residual, and integrity recovery actions', () => {
    const base = { sessionId: null, provisioningStage: 'reserved' as const, failure: null }
    expect(provisioningStageLabel('worktree_created')).toBe('Creating agent session')
    expect(orchestrationRecovery({ ...base, state: 'provisioning' })).toEqual({ kind: 'progress', canRetry: false, canSend: false })
    expect(orchestrationRecovery({
      ...base,
      state: 'failed',
      failure: { stage: 'session_created', retryable: true, residualArtifacts: ['repository_row:one'] },
    })).toEqual({ kind: 'retryable-failure', canRetry: true, canSend: false })
    expect(orchestrationRecovery({
      ...base,
      sessionId: 'session-1',
      state: 'failed',
      failure: { stage: 'worktree_integrity', retryable: false, residualArtifacts: ['worktree_path:/missing'] },
    })).toMatchObject({ kind: 'worktree-integrity', canRetry: false, canSend: false, sendDisabledReason: expect.stringContaining('replacement') })
  })

  it('preserves selected chat independently of stale snapshot replacement', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } })
    window.localStorage.clear()
    writeOrchestrationSelection('env-1', 'workspace-1', 'task-2')
    const replay = new OrchestrationReplayState()
    replay.replace({ generation: 'old', seq: 9 })
    expect(replay.accept({ type: 'stale', cursor: { generation: 'new', seq: 0 } })).toBe('replace')
    expect(readOrchestrationSelection('env-1', 'workspace-1')).toBe('task-2')
    vi.unstubAllGlobals()
  })

  it('normalizes duplicate out-of-order rows and resolves stable selection fallbacks', () => {
    const snapshot = normalizeOrchestrationSnapshot({ dispatches: [
      { id: 'd2', createdAt: '2026-01-02', subtasks: [{ id: 't2', createdAt: '2026-01-02' }] },
      { id: 'd1', createdAt: '2026-01-01', subtasks: [{ id: 'tb', createdAt: 'same' }, { id: 'ta', createdAt: 'same' }, { id: 'ta', createdAt: 'same' }] },
      { id: 'd2', createdAt: '2026-01-02', subtasks: [{ id: 't2', createdAt: '2026-01-02' }] },
    ] })
    expect(snapshot.dispatches.map((dispatch) => dispatch.id)).toEqual(['d1', 'd2'])
    expect(snapshot.dispatches[0]?.subtasks.map((task) => task.id)).toEqual(['ta', 'tb'])
    expect(resolveOrchestrationSelection(snapshot.dispatches, 'ta', 'd2')).toBe('ta')
    expect(resolveOrchestrationSelection(snapshot.dispatches, 'missing', 'd2')).toBe('d2')
    expect(resolveOrchestrationSelection(snapshot.dispatches, 'missing', 'missing')).toBe('d1')
    expect(resolveOrchestrationSelection([], 'missing', 'missing')).toBeNull()
  })

  it('retains only selected, running, and attention sessions and disables archived chats', () => {
    const dispatches = [{ id: 'd1', subtasks: [
      { sessionId: 'inactive', sessionStatus: 'active', running: false, pendingAttentionCount: 0 },
      { sessionId: 'running', sessionStatus: 'active', running: true, pendingAttentionCount: 0 },
      { sessionId: 'attention', sessionStatus: 'active', running: false, pendingAttentionCount: 2 },
      { sessionId: 'archived', sessionStatus: 'archived', running: true, pendingAttentionCount: 1 },
    ] }]
    expect(relevantOrchestrationSessionIds(dispatches, 'inactive')).toEqual(['attention', 'inactive', 'running'])
    expect(orchestrationRecovery({
      state: 'returned', provisioningStage: 'prompt_accepted', sessionId: 'archived', sessionStatus: 'archived', failure: null,
    })).toMatchObject({ canSend: false, sendDisabledReason: expect.stringContaining('archived') })
  })
})
