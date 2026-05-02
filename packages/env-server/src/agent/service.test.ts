import { beforeEach, describe, expect, it, vi } from 'vitest'

type AgentRow = {
  id: string
  workspaceId: string | null
  opencodeSessionId: string
  title: string | null
  status: 'active' | 'archived'
  workingDir: string | null
  selectedProviderId: string | null
  selectedModelId: string | null
  createdAt: string
  lastActivityAt: string
}

type TranscriptRow = {
  sessionId: string
  seq: number
  role: string
  contentJson: string
  createdAt: string
}

const agentRows: AgentRow[] = []
const transcriptRows: TranscriptRow[] = []
const recentRows: Array<{ path: string; label: string | null; lastOpenedAt: string }> = []
let opencodeSessionSeq = 0

function resetState() {
  agentRows.length = 0
  transcriptRows.length = 0
  recentRows.length = 0
  opencodeSessionSeq = 0
}

vi.mock('drizzle-orm', () => ({
  asc: () => ({}),
  desc: () => ({}),
  eq:
    (col: { _col: string }, val: unknown) =>
    (r: Record<string, unknown>) =>
      r[col._col] === val,
}))

vi.mock('../db/schema.js', () => ({
  agentSessions: {
    _table: 'agent_sessions',
    id: { _col: 'id' },
    workspaceId: { _col: 'workspaceId' },
    opencodeSessionId: { _col: 'opencodeSessionId' },
    title: { _col: 'title' },
    status: { _col: 'status' },
    workingDir: { _col: 'workingDir' },
    selectedProviderId: { _col: 'selectedProviderId' },
    selectedModelId: { _col: 'selectedModelId' },
    createdAt: { _col: 'createdAt' },
    lastActivityAt: { _col: 'lastActivityAt' },
  },
  agentTranscripts: {
    _table: 'agent_transcripts',
    sessionId: { _col: 'sessionId' },
    seq: { _col: 'seq' },
    role: { _col: 'role' },
    contentJson: { _col: 'contentJson' },
    createdAt: { _col: 'createdAt' },
  },
  recentFolders: {
    _table: 'recent_folders',
    path: { _col: 'path' },
    label: { _col: 'label' },
    lastOpenedAt: { _col: 'lastOpenedAt' },
  },
}))

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: (table: { _table: string }) => {
        const source = () => (table._table === 'agent_transcripts' ? transcriptRows : agentRows)
        const ordered = () => {
          const rows = [...source()]
          if (table._table === 'agent_transcripts') {
            return rows.sort((a, b) => (a as TranscriptRow).seq - (b as TranscriptRow).seq)
          }
          return (rows as AgentRow[]).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        }
        return {
          orderBy: () => ({
            all: () => ordered(),
            limit: (n: number) => ({ all: () => ordered().slice(0, n) }),
          }),
          where: (pred: (r: Record<string, unknown>) => boolean) => ({
            orderBy: () => ({
              all: () => ordered().filter((r) => pred(r as unknown as Record<string, unknown>)),
              limit: (n: number) => ({
                all: () => ordered().filter((r) => pred(r as unknown as Record<string, unknown>)).slice(0, n),
              }),
            }),
            limit: (n: number) => ({
              all: () => ordered().filter((r) => pred(r as unknown as Record<string, unknown>)).slice(0, n),
            }),
            get: () => source().find((r) => pred(r as unknown as Record<string, unknown>)),
          }),
        }
      },
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        run: () => {
          if ('opencodeSessionId' in value) agentRows.push(value as AgentRow)
          else if ('contentJson' in value) transcriptRows.push(value as TranscriptRow)
          else recentRows.push(value as { path: string; label: string | null; lastOpenedAt: string })
        },
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
          run: () => {
            const path = value.path as string
            const existing = recentRows.find((r) => r.path === path)
            if (existing) Object.assign(existing, set)
            else recentRows.push(value as { path: string; label: string | null; lastOpenedAt: string })
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        run: () => {
          // unused in these tests
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => ({
          run: () => {
            for (const row of agentRows) {
              if (pred(row as unknown as Record<string, unknown>)) Object.assign(row, values)
            }
          },
        }),
      }),
    }),
  },
}))

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: () => ({
    session: {
      create: async ({ body }: { body?: { title?: string } }) => ({
        data: { id: `oc-${++opencodeSessionSeq}`, title: body?.title ?? null },
      }),
      promptAsync: async () => undefined,
    },
  }),
}))

vi.mock('./opencode.js', () => ({
  OpenCodeError: class OpenCodeError extends Error {},
  opencodeBasicAuthHeader: () => 'Basic test',
  opencodeSupervisor: {
    isReady: () => true,
    currentEndpoint: () => ({ host: '127.0.0.1', port: 4099, password: 'pw' }),
    stopAndWait: async () => undefined,
    start: async () => undefined,
  },
}))

vi.mock('../envmeta/service.js', () => ({
  getMeta: () => ({ defaultProviderId: null, defaultModelId: null }),
  setDefaultModel: () => undefined,
}))

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

beforeEach(() => {
  resetState()
  vi.resetModules()
})

describe('agent service workspace sessions', () => {
  it('session creation persists workspaceId and workingDir', async () => {
    const { agentService } = await import('./service.js')

    const session = await agentService.sessionStart({
      workspaceId: 'workspace-a',
      directory: '/tmp/project-a',
      title: 'Project A',
    })

    expect(session.workspaceId).toBe('workspace-a')
    expect(session.workingDir).toBe('/tmp/project-a')
    expect(agentRows[0]).toMatchObject({
      workspaceId: 'workspace-a',
      workingDir: '/tmp/project-a',
      title: 'Project A',
    })
  })

  it('sessionList filters by workspaceId', async () => {
    const { agentService } = await import('./service.js')

    await agentService.sessionStart({ workspaceId: 'workspace-a', directory: '/tmp/a' })
    await agentService.sessionStart({ workspaceId: 'workspace-b', directory: '/tmp/b' })
    await agentService.sessionStart({ directory: '/tmp/legacy' })

    const scoped = await agentService.sessionList({ workspaceId: 'workspace-a' })
    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({ workspaceId: 'workspace-a', workingDir: '/tmp/a' })

    const all = await agentService.sessionList()
    expect(all).toHaveLength(3)
  })

  it('persists transcript events with replay sequence cursors', async () => {
    const { agentService } = await import('./service.js')

    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    await (agentService as unknown as {
      handleEvent(raw: unknown): Promise<void>
    }).handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-1',
          role: 'assistant',
          sessionID: session.opencodeSessionId,
        },
      },
    })

    const replay = await agentService.transcriptReplay(session.id, 0)
    expect(replay).toHaveLength(1)
    expect(replay[0]).toMatchObject({
      seq: 1,
      type: 'message.updated',
      sessionId: session.opencodeSessionId,
    })
    expect(await agentService.transcriptReplay(session.id, 1)).toEqual([])
  })
})
