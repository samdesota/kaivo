// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  refetch: vi.fn(),
  open: vi.fn(),
}))

vi.mock('../../src/env-trpc', () => {
  const claimMutation = { mutateAsync: mocks.claim }
  const completeMutation = { mutateAsync: mocks.complete }
  const cancelMutation = { mutateAsync: mocks.cancel }
  return {
    envTrpc: {
      orchestration: {
        pendingRepoConfigRequest: { useQuery: () => ({
          data: {
            id: 'request-1', workspaceId: 'workspace-1', workingDir: '/workspace/repo',
            repositoryRoot: '/workspace/repo', status: 'pending', createdAt: '2026-07-22T00:00:00Z',
          },
          refetch: mocks.refetch,
        }) },
        claimRepoConfigRequest: { useMutation: () => claimMutation },
        completeRepoConfigRequest: { useMutation: () => completeMutation },
        cancelRepoConfigRequest: { useMutation: () => cancelMutation },
      },
    },
  }
})

vi.mock('../../src/routes/env/env-context', () => ({
  useEnv: () => ({ env: { id: 'env-1', kind: 'local', url: 'http://env.test', label: 'Local' }, envToken: 'token' }),
}))

vi.mock('../../src/lib/overlay-layer-controller', () => ({
  openConfigureRepositoryOverlay: mocks.open,
  openConfirmOverlay: vi.fn(),
}))

const { RepoConfigRequestLauncher } = await import('../../src/routes/env/agent/session-view')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RepoConfigRequestLauncher', () => {
  it('claims the pending request, opens the Git-aware overlay, and completes it', async () => {
    mocks.claim.mockResolvedValue({ workingDir: '/workspace/repo' })
    mocks.open.mockResolvedValue('config-1')
    mocks.complete.mockResolvedValue({ ok: true })
    mocks.refetch.mockResolvedValue(undefined)

    render(<RepoConfigRequestLauncher workspaceId="workspace-1" />)

    await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1', requestId: 'request-1', configId: 'config-1',
    })))
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1', requestId: 'request-1', claimId: expect.any(String),
    }))
    expect(mocks.open).toHaveBeenCalledWith({
      env: { id: 'env-1', kind: 'local', url: 'http://env.test', label: 'Local' },
      envToken: 'token',
      cwd: '/workspace/repo',
    })
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('cancels a claimed request when the detached overlay fails', async () => {
    mocks.claim.mockResolvedValue({ workingDir: '/workspace/repo' })
    mocks.open.mockRejectedValue(new Error('overlay failed'))
    mocks.cancel.mockResolvedValue({ ok: true })
    mocks.refetch.mockResolvedValue(undefined)

    render(<RepoConfigRequestLauncher workspaceId="workspace-1" />)

    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1', requestId: 'request-1', claimId: expect.any(String),
    })))
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})
