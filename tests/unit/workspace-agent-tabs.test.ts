import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyWorkspaceAgentTabRowsForTests,
  ensureWorkspaceAgentTab,
  getWorkspaceAgentTabRecords,
  orderAgentSessionsByTabs,
  reorderWorkspaceAgentTabs,
} from '../../src/data/modules/workspace-agent-tabs'

describe('orderAgentSessionsByTabs', () => {
  it('preserves stored order, appends missing sessions deterministically, and ignores missing or archived sessions', () => {
    const sessions = [
      { id: 'session-a', status: 'active', createdAt: '2026-01-03T00:00:00.000Z' },
      { id: 'session-b', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'session-c', status: 'active', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'session-archived', status: 'archived', createdAt: '2026-01-04T00:00:00.000Z' },
    ]
    const tabs = [
      { workspaceId: 'workspace-1', sessionId: 'session-missing', position: 0, updatedAt: 1 },
      { workspaceId: 'workspace-1', sessionId: 'session-c', position: 1, updatedAt: 1 },
      { workspaceId: 'workspace-1', sessionId: 'session-archived', position: 2, updatedAt: 1 },
    ]

    expect(orderAgentSessionsByTabs({ sessions, tabs }).map((session) => session.id)).toEqual([
      'session-c',
      'session-b',
      'session-a',
    ])
  })
})

describe('workspace agent tab commands', () => {
  afterEach(() => {
    applyWorkspaceAgentTabRowsForTests([])
    vi.restoreAllMocks()
  })

  it('creates missing records once', async () => {
    const fetch = mockTrpcFetch()

    await ensureWorkspaceAgentTab({ workspaceId: 'workspace-1', sessionId: 'session-a' })
    await ensureWorkspaceAgentTab({ workspaceId: 'workspace-1', sessionId: 'session-a' })

    expect(getWorkspaceAgentTabRecords('workspace-1')).toMatchObject([
      { workspaceId: 'workspace-1', sessionId: 'session-a', position: 0 },
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      json: { workspaceId: 'workspace-1', sessionId: 'session-a', position: 0 },
    })
  })

  it('updates positions without duplicate records', async () => {
    const fetch = mockTrpcFetch()
    applyWorkspaceAgentTabRowsForTests([
      { workspaceId: 'workspace-1', sessionId: 'session-a', position: 0, updatedAt: 1 },
      { workspaceId: 'workspace-1', sessionId: 'session-b', position: 1, updatedAt: 1 },
      { workspaceId: 'workspace-1', sessionId: 'session-c', position: 2, updatedAt: 1 },
    ])

    await reorderWorkspaceAgentTabs({ workspaceId: 'workspace-1', sessionIds: ['session-c', 'session-a', 'session-b'] })

    expect(getWorkspaceAgentTabRecords('workspace-1').map((row) => [row.sessionId, row.position])).toEqual([
      ['session-c', 0],
      ['session-a', 1],
      ['session-b', 2],
    ])
    expect(getWorkspaceAgentTabRecords('workspace-1')).toHaveLength(3)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

function mockTrpcFetch() {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const input = init?.body ? JSON.parse(String(init.body)) as { json?: { workspaceId?: string; sessionId?: string; position?: number } } : {}
    return new Response(JSON.stringify({
      result: {
        data: {
          json: {
            workspaceId: input.json?.workspaceId ?? 'workspace-1',
            sessionId: input.json?.sessionId ?? 'session-a',
            position: input.json?.position ?? 0,
            updatedAt: Date.now(),
          },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
