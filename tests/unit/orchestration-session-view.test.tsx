// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationSessionView, usesOrchestrationView } from '../../src/routes/env/agent/orchestration-session-view'

const mocks = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  invalidateQueries: vi.fn(),
  setSnapshotData: vi.fn(),
  completeInputs: [] as Array<Record<string, unknown>>,
  retryInputs: [] as Array<Record<string, unknown>>,
  archiveInputs: [] as Array<Record<string, unknown>>,
  reopenInputs: [] as Array<Record<string, unknown>>,
  openCompletion: vi.fn(async () => true),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}))
vi.mock('../../src/routes/env/env-context', () => ({
  useEnv: () => ({ env: { id: 'env-1', kind: 'local', url: 'http://env.test', label: 'Env' }, envToken: 'token' }),
}))
vi.mock('../../src/lib/overlay-layer-controller', () => ({ openTaskCompletionOverlay: mocks.openCompletion }))
vi.mock('../../src/routes/env/agent/chat-state', () => ({ useRetainChatSessions: vi.fn() }))
vi.mock('../../src/env-trpc', () => ({
  envTrpc: {
    useUtils: () => ({ orchestration: { snapshot: { setData: mocks.setSnapshotData } } }),
    orchestration: {
      snapshot: { useQuery: () => mocks.snapshot },
      changes: { useSubscription: () => undefined },
      complete: { useMutation: () => ({ isPending: false, mutate: (input: Record<string, unknown>) => mocks.completeInputs.push(input) }) },
      retry: { useMutation: (options?: { onSuccess?: () => void }) => ({ isPending: false, error: null, mutate: (input: Record<string, unknown>) => { mocks.retryInputs.push(input); options?.onSuccess?.() } }) },
    },
    agent: {
      sessionClose: { useMutation: () => ({ isPending: false, mutate: (input: Record<string, unknown>) => mocks.archiveInputs.push(input) }) },
      sessionReopen: { useMutation: () => ({ isPending: false, mutate: (input: Record<string, unknown>) => mocks.reopenInputs.push(input) }) },
    },
  },
}))

function data() {
  return {
    cursor: { generation: 'test', seq: 3 },
    dispatches: [{
      id: 'dispatch-1', title: 'Release', status: 'active', workingDir: '/repo', createdAt: '2026-07-21T00:00:00Z',
      subtasks: [{
        id: 'task-1', dispatchSessionId: 'dispatch-1', sessionId: 'session-1', sessionStatus: 'active', title: 'Implement UI', state: 'returned',
        provisioningStage: 'prompt_accepted', sourceRef: 'main', branchName: 'task/ui', deliveryMode: 'pull_request',
        delivery: { pullRequestUrl: 'https://github.com/acme/ui/pull/7', headCommit: 'abc123', summary: 'Ready' },
        worktreePath: '/repo-task', failure: null, latestReturn: { kind: 'response', summary: 'Ready', sequence: 1 },
        running: false, pendingAttentionCount: 2, completedAt: null, createdAt: '2026-07-21T00:00:01Z', updatedAt: '2026-07-21T00:00:02Z',
      }],
    }],
  }
}

beforeEach(() => {
  mocks.snapshot = { data: data(), isLoading: false, error: null }
  mocks.invalidateQueries.mockReset()
  mocks.completeInputs.length = 0
  mocks.retryInputs.length = 0
  mocks.archiveInputs.length = 0
  mocks.reopenInputs.length = 0
  mocks.openCompletion.mockReset()
  mocks.openCompletion.mockResolvedValue(true)
})
afterEach(() => cleanup())

describe('OrchestrationSessionView', () => {
  it('uses orchestration chrome for dispatches and directly selected subtasks', () => {
    expect(usesOrchestrationView('chat', 'workspace-1')).toBe(false)
    expect(usesOrchestrationView('subtask', 'workspace-1', true)).toBe(true)
    expect(usesOrchestrationView('dispatch', 'workspace-1')).toBe(true)
    expect(usesOrchestrationView('dispatch', undefined)).toBe(false)
  })

  it('renders one chat with a collapsible dispatch state banner instead of a navigator', () => {
    render(<OrchestrationSessionView workspaceId="workspace-1" sessionId="dispatch-1" renderChat={(id) => <div>Chat {id}</div>} />)
    expect(screen.getByText('Chat dispatch-1')).toBeTruthy()
    expect(screen.queryByLabelText('Orchestration navigator')).toBeNull()
    const disclosure = screen.getByRole('button', { name: /Task state/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(screen.getByText('Implement UI')).toBeTruthy()
    expect(screen.getByText('returned')).toBeTruthy()
  })

  it('shows task metadata and completion controls above the normal selected task chat', async () => {
    render(<OrchestrationSessionView workspaceId="workspace-1" sessionId="session-1" renderChat={(id, dir) => <div>Chat {id} {dir}</div>} />)
    expect(screen.getByText('Chat session-1 /repo-task')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Implement UI/ }))
    expect(screen.getByText('https://github.com/acme/ui/pull/7')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }))
    await waitFor(() => expect(mocks.openCompletion).toHaveBeenCalled())
    expect(mocks.completeInputs).toEqual([{ workspaceId: 'workspace-1', subtaskId: 'task-1' }])
  })

  it('keeps retry and archive controls in the expanded task banner', () => {
    const snapshot = data()
    snapshot.dispatches[0]!.subtasks[0]!.state = 'failed'
    snapshot.dispatches[0]!.subtasks[0]!.failure = { stage: 'session_created', message: 'OpenCode unavailable', retryable: true, residualArtifacts: ['repository_row:repo-1'] }
    mocks.snapshot = { data: snapshot, isLoading: false, error: null }
    render(<OrchestrationSessionView workspaceId="workspace-1" sessionId="session-1" renderChat={(id) => <div>Chat {id}</div>} />)
    fireEvent.click(screen.getByRole('button', { name: /Implement UI/ }))
    expect(screen.getByText('repository_row:repo-1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry provisioning' }))
    expect(mocks.retryInputs).toEqual([{ workspaceId: 'workspace-1', subtaskId: 'task-1' }])
    fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }))
    expect(mocks.archiveInputs).toEqual([{ sessionId: 'session-1' }])
  })
})
