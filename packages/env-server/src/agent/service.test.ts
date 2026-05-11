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
  selectedModelVariant: string | null
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
const createAgentNotificationMock = vi.hoisted(() => vi.fn())
const opencodeMessagesData = vi.hoisted(() => [] as Array<{
  info?: { role?: string }
  parts?: Array<{ type?: string; text?: string }>
}>)

function resetState() {
  agentRows.length = 0
  transcriptRows.length = 0
  recentRows.length = 0
  opencodeMessagesData.length = 0
  opencodeSessionSeq = 0
  createAgentNotificationMock.mockReset()
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
    selectedModelVariant: { _col: 'selectedModelVariant' },
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
        const source = () => {
          if (table._table === 'agent_transcripts') return transcriptRows
          return agentRows
        }
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
      messages: async () => ({ data: opencodeMessagesData }),
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

vi.mock('../identity/client.js', () => ({
  IdentityAuthError: class IdentityAuthError extends Error {},
  IdentityUnreachableError: class IdentityUnreachableError extends Error {},
  resolveProviderKeys: async () => ({}),
  createAgentNotification: createAgentNotificationMock,
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

  it('normalizes Anthropic fast-tier session model selections to standard tier', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })

    await agentService.setSessionModel(session.id, {
      providerID: 'anthropic',
      modelID: 'claude-opus-4-6-fast',
    })

    await expect(agentService.getSessionModel(session.id)).resolves.toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-6',
    })
    expect(agentRows[0]).toMatchObject({
      selectedProviderId: 'anthropic',
      selectedModelId: 'claude-opus-4-6',
    })
  })

  it('creates a workspace notification when a running session becomes idle', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a', title: 'Implement notifications' })
    opencodeMessagesData.push({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'Implemented sidebar notifications for finished chats.' }],
    })

    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          type: 'text',
          text: 'Implemented sidebar notifications for finished chats.',
          sessionID: session.opencodeSessionId,
        },
      },
    })
    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'session.idle',
      properties: { sessionID: session.opencodeSessionId },
    })

    await vi.waitFor(() => expect(createAgentNotificationMock).toHaveBeenCalledTimes(1))
    expect(createAgentNotificationMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      sessionId: session.id,
      kind: 'finished',
      title: 'Implement notifications',
      summary: 'Implemented sidebar notifications for finished chats.',
    })
  })

  it('uses a brief last-response fallback instead of the chat title when summarization is unavailable', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a', title: 'setup a todo list' })

    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'assistant-message-1',
          role: 'assistant',
          sessionID: session.opencodeSessionId,
        },
      },
    })
    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          messageID: 'assistant-message-1',
          type: 'text',
          text: 'Created the requested todo list and organized the next implementation steps. Extra details should not appear.',
          sessionID: session.opencodeSessionId,
        },
      },
    })
    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'session.idle',
      properties: { sessionID: session.opencodeSessionId },
    })

    await vi.waitFor(() => expect(createAgentNotificationMock).toHaveBeenCalledTimes(1))
    expect(createAgentNotificationMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      sessionId: session.id,
      kind: 'finished',
      title: 'setup a todo list',
      summary: 'Created the requested todo list and organized the next implementation steps.',
    })
    expect(createAgentNotificationMock.mock.calls[0]?.[0]?.summary).not.toBe('setup a todo list')
  })

  it('creates workspace notifications for blocking questions and permission requests', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a', title: 'Blocking task' })

    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'question.asked',
      properties: {
        id: 'question-1',
        sessionID: session.opencodeSessionId,
        questions: [{ question: 'Which deployment target should I use?', options: [] }],
      },
    })
    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'permission.updated',
      properties: {
        id: 'permission-1',
        sessionID: session.opencodeSessionId,
        permission: 'bash',
        pattern: 'npm test',
      },
    })

    await vi.waitFor(() => expect(createAgentNotificationMock).toHaveBeenCalledTimes(2))
    expect(createAgentNotificationMock).toHaveBeenNthCalledWith(1, {
      workspaceId: 'workspace-a',
      sessionId: session.id,
      kind: 'question',
      title: 'Blocking task',
      summary: 'Which deployment target should I use?',
    })
    expect(createAgentNotificationMock).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-a',
      sessionId: session.id,
      kind: 'permission',
      title: 'Blocking task',
      summary: 'bash: npm test',
    })
  })

  it('updates agent runtime realtime rows from session and pending events', async () => {
    const { agentService } = await import('./service.js')
    const { AGENT_SESSION_RUNTIME_TABLE, getAgentRuntimeRealtime } = await import('./runtime-realtime.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a', title: 'Runtime task' })

    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'part-1', type: 'text', text: 'Working', sessionID: session.opencodeSessionId } },
    })
    expect(getAgentRuntimeRealtime().snapshot(AGENT_SESSION_RUNTIME_TABLE).rows[0]).toMatchObject({
      sessionId: session.id,
      workspaceId: 'workspace-a',
      running: true,
      pendingAttentionCount: 0,
    })

    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'question.asked',
      properties: { id: 'question-1', sessionID: session.opencodeSessionId, questions: [] },
    })
    expect(getAgentRuntimeRealtime().snapshot(AGENT_SESSION_RUNTIME_TABLE).rows[0]).toMatchObject({
      running: true,
      pendingAttentionCount: 1,
    })

    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'question.replied',
      properties: { sessionID: session.opencodeSessionId, requestID: 'question-1' },
    })
    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'session.idle',
      properties: { sessionID: session.opencodeSessionId },
    })
    expect(getAgentRuntimeRealtime().snapshot(AGENT_SESSION_RUNTIME_TABLE).rows[0]).toMatchObject({
      running: false,
      pendingAttentionCount: 0,
    })
  })
})
