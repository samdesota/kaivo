import { beforeEach, describe, expect, it, vi } from 'vitest'

type AgentRow = {
  id: string
  workspaceId: string | null
  opencodeSessionId: string
  title: string | null
  status: 'active' | 'archived'
  kind: 'chat' | 'dispatch' | 'subtask'
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
let agentInsertError = false
let opencodeDeleteError = false
const deletedOpencodeSessions: string[] = []
const createAgentNotificationMock = vi.hoisted(() => vi.fn())
const opencodeMessagesData = vi.hoisted(() => [] as Array<{
  info?: { role?: string; providerID?: string; modelID?: string; tokens?: { input?: number; total?: number; cache?: { read?: number } } }
  parts?: Array<{ type?: string; text?: string; tokens?: { input?: number; total?: number; cache?: { read?: number } } }>
}>)
const opencodeStatusData = vi.hoisted(() => new Map<string, { type: string; message?: string }>())
const opencodeAbortCalls = vi.hoisted(() => [] as string[])
const opencodeMessageCalls = vi.hoisted(() => [] as unknown[])
const opencodeStatusCalls = vi.hoisted(() => [] as unknown[])
const opencodeTodoCalls = vi.hoisted(() => [] as unknown[])
const opencodeProviderCalls = vi.hoisted(() => [] as unknown[])
const opencodePermissionCalls = vi.hoisted(() => [] as Array<{ sessionId: string; permissionId: string; response: string }>)
const opencodePermissionFetchCalls = vi.hoisted(() => [] as Array<{ url: string; reply: string }>)
const opencodePermissionError = vi.hoisted(() => ({ value: null as Error | null }))
const opencodePromptCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const opencodePromptError = vi.hoisted(() => ({ value: null as Error | null }))
const opencodeAuthMethods = vi.hoisted(() => ({
  openai: [
    { type: 'oauth', label: 'Codex OAuth (ChatGPT Plus/Pro)' },
    { type: 'oauth', label: 'Codex OAuth (Device Code)' },
    { type: 'oauth', label: 'Codex OAuth (Manual URL Paste)' },
  ],
}))
const opencodeOAuthAuthorizeCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const opencodeOAuthCallbackCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const opencodeOAuthAuthorizeUrl = vi.hoisted(() => ({ value: 'https://auth.openai.com/device' }))
const opencodeOAuthInstructions = vi.hoisted(() => ({ value: 'Enter this one-time code: ABCD-EFGH' }))

function resetState() {
  agentRows.length = 0
  transcriptRows.length = 0
  recentRows.length = 0
  opencodeMessagesData.length = 0
  opencodeStatusData.clear()
  opencodeAbortCalls.length = 0
  opencodeMessageCalls.length = 0
  opencodeStatusCalls.length = 0
  opencodeTodoCalls.length = 0
  opencodeProviderCalls.length = 0
  opencodePermissionCalls.length = 0
  opencodePermissionFetchCalls.length = 0
  opencodePermissionError.value = null
  opencodePromptCalls.length = 0
  opencodePromptError.value = null
  opencodeOAuthAuthorizeCalls.length = 0
  opencodeOAuthCallbackCalls.length = 0
  opencodeOAuthAuthorizeUrl.value = 'https://auth.openai.com/device'
  opencodeOAuthInstructions.value = 'Enter this one-time code: ABCD-EFGH'
  opencodeSessionSeq = 0
  agentInsertError = false
  opencodeDeleteError = false
  deletedOpencodeSessions.length = 0
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
    kind: { _col: 'kind' },
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
          if ('opencodeSessionId' in value) {
            if (agentInsertError) {
              agentInsertError = false
              throw new Error('agent row insert failed')
            }
            agentRows.push(value as AgentRow)
          }
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
      messages: async (options: unknown) => {
        opencodeMessageCalls.push(options)
        return { data: opencodeMessagesData }
      },
      status: async (options: unknown) => {
        opencodeStatusCalls.push(options)
        return { data: Object.fromEntries(opencodeStatusData) }
      },
      todo: async (options: unknown) => {
        opencodeTodoCalls.push(options)
        return { data: [] }
      },
      abort: async ({ path }: { path: { id: string } }) => {
        opencodeAbortCalls.push(path.id)
        opencodeStatusData.delete(path.id)
      },
      promptAsync: async (options: Record<string, unknown>) => {
        opencodePromptCalls.push(options)
        if (opencodePromptError.value) throw opencodePromptError.value
      },
      delete: async ({ path }: { path: { id: string } }) => {
        if (opencodeDeleteError) throw new Error('delete failed')
        deletedOpencodeSessions.push(path.id)
        return { data: true }
      },
    },
    config: {
      providers: async (options: unknown) => {
        opencodeProviderCalls.push(options)
        return {
          data: {
            providers: [
              {
                id: 'openai',
                models: {
                  'gpt-5.5': { id: 'gpt-5.5', limit: { context: 1_050_000, input: 272_000 } },
                },
              },
            ],
          },
        }
      },
    },
    provider: {
      auth: async () => ({ data: opencodeAuthMethods }),
      oauth: {
        authorize: async (options: Record<string, unknown>) => {
          opencodeOAuthAuthorizeCalls.push(options)
          return {
            data: {
              url: opencodeOAuthAuthorizeUrl.value,
              instructions: opencodeOAuthInstructions.value,
            },
          }
        },
        callback: async (options: Record<string, unknown>) => {
          opencodeOAuthCallbackCalls.push(options)
          return { data: true }
        },
      },
    },
    postSessionIdPermissionsPermissionId: async ({
      path,
      body,
    }: {
      path: { id: string; permissionID: string }
      body: { response: string }
    }) => {
      opencodePermissionCalls.push({ sessionId: path.id, permissionId: path.permissionID, response: body.response })
      if (opencodePermissionError.value) throw opencodePermissionError.value
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
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/permission/')) {
      const body = init?.body ? JSON.parse(String(init.body)) as { reply?: string } : {}
      opencodePermissionFetchCalls.push({ url, reply: body.reply ?? '' })
      if (opencodePermissionError.value) {
        return new Response(opencodePermissionError.value.message, { status: 404 })
      }
      return new Response('true', { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }))
  vi.resetModules()
})

describe('agent context usage limits', () => {
  it('prefers the model input limit used by OpenCode compaction', async () => {
    const { practicalContextUsageLimit } = await import('./service.js')

    expect(practicalContextUsageLimit({ context: 1_050_000, input: 272_000 })).toBe(272_000)
  })

  it('falls back to context when no input limit is reported', async () => {
    const { practicalContextUsageLimit } = await import('./service.js')

    expect(practicalContextUsageLimit({ context: 1_050_000 })).toBe(1_050_000)
  })
})

describe('OpenAI OAuth', () => {
  it('uses the Device Code method instead of the blocking browser method', async () => {
    const { agentService } = await import('./service.js')

    await expect(agentService.openAIOAuthStart()).resolves.toEqual({
      url: 'https://auth.openai.com/device',
      deviceCode: 'ABCD-EFGH',
      methodIndex: 1,
    })
    expect(opencodeOAuthAuthorizeCalls[0]).toMatchObject({ body: { method: 1 } })
    expect(opencodeOAuthCallbackCalls[0]).toMatchObject({ body: { method: 1 } })
  })

  it('rejects an empty authorization URL before starting the callback', async () => {
    const { agentService } = await import('./service.js')
    opencodeOAuthAuthorizeUrl.value = '   '

    await expect(agentService.openAIOAuthStart()).rejects.toMatchObject({
      code: 'unavailable',
      message: 'OpenAI OAuth did not return a login URL',
    })
    expect(opencodeOAuthCallbackCalls).toEqual([])
  })
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
    expect(session.kind).toBe('chat')
    expect(agentRows[0]).toMatchObject({
      workspaceId: 'workspace-a',
      workingDir: '/tmp/project-a',
      title: 'Project A',
      kind: 'chat',
    })
  })

  it('sessionList filters by workspaceId', async () => {
    const { agentService } = await import('./service.js')

    await agentService.sessionStart({ workspaceId: 'workspace-a', directory: '/tmp/a' })
    await agentService.sessionStart({ workspaceId: 'workspace-b', directory: '/tmp/b' })
    await agentService.sessionStart({ directory: '/tmp/legacy' })
    await agentService.sessionStartInternal({ workspaceId: 'workspace-a', directory: '/tmp/task', kind: 'subtask' })

    const scoped = await agentService.sessionList({ workspaceId: 'workspace-a' })
    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({ workspaceId: 'workspace-a', workingDir: '/tmp/a' })

    const all = await agentService.sessionList()
    expect(all).toHaveLength(3)
    expect(await agentService.sessionList({ includeSubtasks: true })).toHaveLength(4)
  })

  it('exposes dispatch to workspace agents and delivery only to subtasks', async () => {
    const { agentService } = await import('./service.js')
    const chat = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    const dispatch = await agentService.sessionStartInternal({ workspaceId: 'workspace-a', kind: 'dispatch' })
    const subtask = await agentService.sessionStartInternal({ workspaceId: 'workspace-a', kind: 'subtask' })
    const unscoped = await agentService.sessionStart({})

    await agentService.sessionSend({ sessionId: chat.id, message: 'chat' })
    await agentService.sessionSend({ sessionId: dispatch.id, message: 'dispatch' })
    await agentService.sessionSend({ sessionId: subtask.id, message: 'subtask' })
    await agentService.sessionSend({ sessionId: unscoped.id, message: 'unscoped' })

    const toolFlags = opencodePromptCalls.map((call) =>
      ((call.body as { tools: Record<string, boolean> }).tools).kaivo_dispatch_subtask,
    )
    expect(toolFlags).toEqual([true, true, false, false])
    const deliveryFlags = opencodePromptCalls.map((call) =>
      ((call.body as { tools: Record<string, boolean> }).tools).kaivo_report_subtask_delivery,
    )
    expect(deliveryFlags).toEqual([false, false, true, false])
  })

  it('converts only active workspace chats to dispatch sessions', async () => {
    const { agentService } = await import('./service.js')
    const chat = await agentService.sessionStart({ workspaceId: 'workspace-a', directory: '/tmp/a' })

    await expect(agentService.sessionConvertToDispatch({ sessionId: chat.id }))
      .resolves.toMatchObject({ id: chat.id, workspaceId: 'workspace-a', kind: 'dispatch' })
    expect(agentRows[0]?.kind).toBe('dispatch')
    await expect(agentService.sessionConvertToDispatch({ sessionId: chat.id }))
      .rejects.toMatchObject({ code: 'invalid_state' })

    const archived = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    await agentService.sessionSetStatus({ sessionId: archived.id, status: 'archived' })
    await expect(agentService.sessionConvertToDispatch({ sessionId: archived.id }))
      .rejects.toMatchObject({ code: 'invalid_state' })

    const unscoped = await agentService.sessionStart({ directory: '/tmp/unscoped' })
    await expect(agentService.sessionConvertToDispatch({ sessionId: unscoped.id }))
      .rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('keeps archived transcripts readable but rejects sends until reopen', async () => {
    const { agentService } = await import('./service.js')
    const subtask = await agentService.sessionStartInternal({ workspaceId: 'workspace-a', kind: 'subtask' })
    await agentService.sessionSetStatus({ sessionId: subtask.id, status: 'archived' })

    await expect(agentService.sessionSend({ sessionId: subtask.id, message: 'must not send' }))
      .rejects.toMatchObject({ code: 'invalid_state' })
    await expect(agentService.openCodeSessionMessages(subtask.id)).resolves.toEqual([])

    await agentService.sessionSetStatus({ sessionId: subtask.id, status: 'active' })
    await expect(agentService.sessionSend({ sessionId: subtask.id, message: 'resumed' })).resolves.toEqual({ queued: false })
  })

  it('rechecks OpenCode status instead of queueing from stale running state', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'session.busy',
      properties: { sessionID: session.opencodeSessionId },
    })
    opencodeStatusData.set(session.opencodeSessionId, { type: 'idle' })

    await expect(agentService.sessionSend({ sessionId: session.id, message: 'send now' }))
      .resolves.toEqual({ queued: false })

    expect(opencodeStatusCalls).toHaveLength(1)
    expect(opencodePromptCalls).toHaveLength(1)
  })

  it('clears running state when prompt submission fails', async () => {
    const { agentService } = await import('./service.js')
    const { AGENT_SESSION_RUNTIME_TABLE, getAgentRuntimeRealtime } = await import('./runtime-realtime.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    opencodePromptError.value = new Error('prompt rejected')

    await expect(agentService.sessionSend({ sessionId: session.id, message: 'fail' }))
      .rejects.toThrow('prompt rejected')

    expect(getAgentRuntimeRealtime().snapshot(AGENT_SESSION_RUNTIME_TABLE).rows[0]).toMatchObject({
      sessionId: session.id,
      running: false,
    })
  })

  it('compensates an OpenCode session when persisting its agent row fails', async () => {
    const { agentService } = await import('./service.js')
    agentInsertError = true

    await expect(agentService.sessionStartInternal({ workspaceId: 'workspace-a', kind: 'subtask' }))
      .rejects.toThrow('agent row insert failed')
    expect(agentRows).toEqual([])
    expect(deletedOpencodeSessions).toEqual(['oc-1'])
  })

  it('reports an orphan OpenCode session when compensation fails', async () => {
    const { agentService } = await import('./service.js')
    agentInsertError = true
    opencodeDeleteError = true

    await expect(agentService.sessionStartInternal({ workspaceId: 'workspace-a', kind: 'subtask' }))
      .rejects.toMatchObject({
        code: 'start_failed',
        residualArtifacts: ['opencode_session:oc-1'],
      })
  })

  it('keeps OpenCode message events live-only without replay rows', async () => {
    const { agentService } = await import('./service.js')

    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    const liveEvents: Array<{ type: string; seq?: number }> = []
    const unsubscribe = agentService.subscribeTranscript(session.id, (evt) => {
      liveEvents.push({ type: evt.type, seq: evt.seq })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
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
    await (agentService as unknown as {
      handleEvent(raw: unknown): Promise<void>
    }).handleEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          messageID: 'msg-1',
          type: 'text',
          text: 'Live response',
          sessionID: session.opencodeSessionId,
        },
      },
    })

    const replay = await agentService.transcriptReplay(session.id, 0)
    expect(replay).toEqual([])
    expect(transcriptRows).toHaveLength(0)
    await vi.waitFor(() => expect(liveEvents.map((evt) => evt.type)).toEqual(['message.updated', 'message.part.updated']))
    expect(liveEvents.every((evt) => evt.seq === undefined)).toBe(true)
    unsubscribe()
  })

  it('persists session errors with replay sequence cursors', async () => {
    const { agentService } = await import('./service.js')

    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'session.error',
      properties: {
        sessionID: session.opencodeSessionId,
        message: 'durable provider error',
        time: { created: 123 },
      },
    })

    const replay = await agentService.transcriptReplay(session.id, 0)
    expect(replay).toHaveLength(1)
    expect(replay[0]).toMatchObject({
      seq: 1,
      type: 'session.error',
      sessionId: session.opencodeSessionId,
      payload: { message: 'durable provider error' },
    })
    expect(await agentService.transcriptReplay(session.id, 1)).toEqual([])
  })

  it('surfaces opencode retry status as a transcript error once', async () => {
    const { agentService } = await import('./service.js')

    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    opencodeStatusData.set(session.opencodeSessionId, {
      type: 'retry',
      message: 'unknown provider for model gpt-5.5-pro',
    })

    const status = await agentService.sessionStatus({ sessionId: session.id })
    expect(status.running).toBe(false)
    expect(opencodeAbortCalls).toEqual([session.opencodeSessionId])

    await agentService.sessionStatus({ sessionId: session.id })
    const replay = await agentService.transcriptReplay(session.id, 0)
    const errors = replay.filter((evt) => evt.type === 'session.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.payload).toMatchObject({
      sessionID: session.opencodeSessionId,
      message: 'unknown provider for model gpt-5.5-pro',
    })
    await vi.waitFor(() => expect(createAgentNotificationMock).toHaveBeenCalledTimes(1))
    expect(createAgentNotificationMock.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'workspace-a',
      sessionId: session.id,
      kind: 'error',
      summary: 'unknown provider for model gpt-5.5-pro',
    })
  })

  it('uses a recent-message read for context usage and preserves model limit lookup', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    opencodeMessagesData.push(
      { info: { role: 'assistant', providerID: 'openai', modelID: 'gpt-5.5', tokens: { total: 123_456 } }, parts: [] },
    )

    const status = await agentService.sessionStatus({ sessionId: session.id })

    expect(status.contextUsage).toEqual({ used: 123_456, limit: 272_000 })
    expect(opencodeMessageCalls.at(-1)).toMatchObject({
      path: { id: session.opencodeSessionId },
      query: { limit: 20 },
    })
    expect(opencodeProviderCalls).toHaveLength(1)
  })

  it('preserves directory options for status todo and recent message reads', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a', directory: '/tmp/project-status' })

    await agentService.sessionStatus({ sessionId: session.id })

    expect(opencodeTodoCalls.at(-1)).toMatchObject({
      path: { id: session.opencodeSessionId },
      query: { directory: '/tmp/project-status' },
      headers: { 'x-opencode-directory': '/tmp/project-status' },
    })
    expect(opencodeStatusCalls.at(-1)).toMatchObject({
      query: { directory: '/tmp/project-status' },
      headers: { 'x-opencode-directory': '/tmp/project-status' },
    })
    expect(opencodeMessageCalls.at(-1)).toMatchObject({
      path: { id: session.opencodeSessionId },
      query: { directory: '/tmp/project-status', limit: 20 },
      headers: { 'x-opencode-directory': '/tmp/project-status' },
    })
  })

  it('does not surface user aborts as transcript errors', async () => {
    const { agentService } = await import('./service.js')

    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    await agentService.sessionAbort({ sessionId: session.id })
    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'session.error',
      properties: {
        sessionID: session.opencodeSessionId,
        message: 'aborted',
        time: { created: 123 },
      },
    })

    const replay = await agentService.transcriptReplay(session.id, 0)
    expect(replay).toEqual([])
    expect(createAgentNotificationMock).not.toHaveBeenCalled()
  })

  it('projects persisted session errors into canonical session messages only for the matching session', async () => {
    const { agentService } = await import('./service.js')

    const failed = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    const unrelated = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'session.error',
      properties: {
        sessionID: failed.opencodeSessionId,
        message: 'unknown provider for model gpt-5.5-pro',
        time: { created: 123 },
      },
    })

    const failedMessages = await agentService.sessionMessages(failed.id)
    const failedError = failedMessages.flatMap((message) => message.parts).find((part) => part.type === 'session-error')
    expect(failedError).toMatchObject({
      sessionID: failed.opencodeSessionId,
      message: 'unknown provider for model gpt-5.5-pro',
    })

    const unrelatedMessages = await agentService.sessionMessages(unrelated.id)
    expect(unrelatedMessages.flatMap((message) => message.parts).some((part) => part.type === 'session-error')).toBe(false)

    const rawMessages = await agentService.openCodeSessionMessages(failed.id)
    expect(rawMessages.flatMap((message) => message.parts).some((part) => part.type === 'session-error')).toBe(false)
  })

  it('preserves fast-tier session model selections', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })

    await agentService.setSessionModel(session.id, {
      providerID: 'anthropic',
      modelID: 'claude-opus-4-6-fast',
    })

    await expect(agentService.getSessionModel(session.id)).resolves.toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-6-fast',
    })
    expect(agentRows[0]).toMatchObject({
      selectedProviderId: 'anthropic',
      selectedModelId: 'claude-opus-4-6-fast',
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
    opencodeMessagesData.push({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'Created the requested todo list and organized the next implementation steps. Extra details should not appear.' }],
    })

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

  it('clears stale permissions when opencode no longer has the request', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a', title: 'Stale permission task' })

    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'permission.updated',
      properties: {
        id: 'permission-1',
        sessionID: session.opencodeSessionId,
        permission: 'bash',
        pattern: 'npm test',
      },
    })

    expect((await agentService.sessionStatus({ sessionId: session.id })).pendingApprovals).toHaveLength(1)
    opencodePermissionError.value = new Error('Permission request not found: permission-1')

    await agentService.sessionRespond({
      sessionId: session.id,
      permissionId: 'permission-1',
      response: 'reject',
    })

    expect(opencodePermissionFetchCalls).toHaveLength(1)
    expect(opencodePermissionFetchCalls[0]?.url).toContain('/permission/permission-1/reply')
    expect(opencodePermissionFetchCalls[0]?.reply).toBe('reject')
    expect((await agentService.sessionStatus({ sessionId: session.id })).pendingApprovals).toEqual([])
    const replay = await agentService.transcriptReplay(session.id, 0)
    expect(replay.map((evt) => evt.type)).toEqual(['permission.replied'])
    expect(replay[0]?.payload).toMatchObject({
      sessionID: session.opencodeSessionId,
      permissionID: 'permission-1',
    })
  })

  it('clears pending permissions from requestID reply events', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a', title: 'Permission reply task' })

    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'permission.updated',
      properties: {
        id: 'permission-1',
        sessionID: session.opencodeSessionId,
        permission: 'bash',
        pattern: 'npm test',
      },
    })
    expect((await agentService.sessionStatus({ sessionId: session.id })).pendingApprovals).toHaveLength(1)

    await (agentService as unknown as { handleEvent(raw: unknown): Promise<void> }).handleEvent({
      type: 'permission.replied',
      properties: {
        sessionID: session.opencodeSessionId,
        requestID: 'permission-1',
        reply: 'once',
      },
    })

    expect((await agentService.sessionStatus({ sessionId: session.id })).pendingApprovals).toEqual([])
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

  it('repairs stale runtime state from authoritative status polling', async () => {
    const { agentService } = await import('./service.js')
    const { AGENT_SESSION_RUNTIME_TABLE, getAgentRuntimeRealtime } = await import('./runtime-realtime.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    getAgentRuntimeRealtime().upsert(AGENT_SESSION_RUNTIME_TABLE, {
      sessionId: session.id,
      workspaceId: 'workspace-a',
      running: true,
      pendingAttentionCount: 0,
      lastActivityAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    opencodeStatusData.set(session.opencodeSessionId, { type: 'idle' })

    await expect(agentService.sessionStatus({ sessionId: session.id })).resolves.toMatchObject({ running: false })

    expect(getAgentRuntimeRealtime().snapshot(AGENT_SESSION_RUNTIME_TABLE).rows[0]).toMatchObject({
      sessionId: session.id,
      running: false,
    })
  })

  it('drains a queued follow-up when status polling discovers the session is idle', async () => {
    const { agentService } = await import('./service.js')
    const session = await agentService.sessionStart({ workspaceId: 'workspace-a' })
    opencodeStatusData.set(session.opencodeSessionId, { type: 'busy' })

    await expect(agentService.sessionSend({ sessionId: session.id, message: 'queued follow-up' }))
      .resolves.toMatchObject({ queued: true })
    expect(opencodePromptCalls).toEqual([])

    opencodeStatusData.set(session.opencodeSessionId, { type: 'idle' })
    await agentService.sessionStatus({ sessionId: session.id })

    await vi.waitFor(() => expect(opencodePromptCalls).toHaveLength(1))
    expect(opencodePromptCalls[0]).toMatchObject({
      path: { id: session.opencodeSessionId },
    })
  })
})
