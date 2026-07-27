import { eq, desc, asc } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { db } from '../db/client.js'
import { agentSessions, agentTranscripts, type AgentSessionKind, type AgentSessionStatus } from '../db/schema.js'
import { logger } from '../logger.js'
import { recentFolderService } from '../recent-folders/service.js'
import { getMeta, setDefaultModel as setEnvDefaultModel } from '../envmeta/service.js'
import { AGENT_SESSION_RUNTIME_TABLE, getAgentRuntimeRealtime } from './runtime-realtime.js'
import {
  OpenCodeError,
  hasOpenAIOAuthMarker,
  markOpenAIOAuthEnabled,
  opencodeBasicAuthHeader,
  opencodeSupervisor,
} from './opencode.js'
import { createAgentNotification, IdentityAuthError, IdentityUnreachableError, resolveProviderKeys } from '../identity/client.js'

const BUILTIN_DEFAULT_MODEL = { providerID: 'openai', modelID: 'gpt-5.6-sol' } as const
const REASONING_EFFORT_VARIANTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
type ModelLimit = { context?: number; input?: number }
export type ReasoningEffortVariant = typeof REASONING_EFFORT_VARIANTS[number]
export type SessionModelSelection = {
  providerID: string | null
  modelID: string | null
  variant: ReasoningEffortVariant | null
}

type OpenAIOAuthStatus = {
  state: 'idle' | 'pending' | 'connected' | 'failed'
  message: string | null
  startedAt: Date | null
  completedAt: Date | null
}

const CLOUD_TOOL_OVERRIDES = {
  bash: false,
  pty: false,
  kaivo_bash: true,
  kaivo_pty: true,
  kaivo_pty_list: true,
  kaivo_pty_write: true,
  kaivo_pty_read: true,
  kaivo_pty_close: true,
  kaivo_open_pane: true,
  websearch: true,
} as const

const RECENT_MESSAGE_CONTEXT_LIMIT = 20

function directoryOpts(dir: string | null | undefined) {
  if (!dir) return {}
  return {
    query: { directory: dir },
    headers: { 'x-opencode-directory': dir },
  }
}

function directoryQueryOpts(dir: string | null | undefined, query: Record<string, unknown>) {
  const opts = directoryOpts(dir)
  return {
    ...opts,
    query: { ...('query' in opts ? opts.query : {}), ...query },
  }
}

function isReasoningEffortVariant(value: string | null | undefined): value is ReasoningEffortVariant {
  return REASONING_EFFORT_VARIANTS.includes(value as ReasoningEffortVariant)
}

export function practicalContextUsageLimit(limit: ModelLimit | null | undefined): number | null {
  return limit?.input ?? limit?.context ?? null
}

function promptBody(input: {
  text: string
  model: { providerID: string; modelID: string }
  variant?: ReasoningEffortVariant | null
  sessionKind: AgentSessionKind
  workspaceScoped: boolean
}) {
  return {
    parts: [{ type: 'text' as const, text: input.text }],
    tools: {
      ...CLOUD_TOOL_OVERRIDES,
      kaivo_dispatch_subtask: input.workspaceScoped && input.sessionKind !== 'subtask',
      kaivo_report_subtask_delivery: input.sessionKind === 'subtask',
    },
    model: input.model,
    ...(input.variant ? { variant: input.variant } : {}),
  }
}

function truncatePromptForTitle(msg: string): string {
  const flat = msg.replace(/\s+/g, ' ').trim()
  if (flat.length <= 60) return flat
  return flat.slice(0, 57).replace(/[\s.,;:!?-]+$/, '') + '…'
}

export class AgentError extends Error {
  constructor(
    public code:
      | 'not_ready'
      | 'no_provider'
      | 'not_found'
      | 'invalid_state'
      | 'unavailable'
      | 'start_failed',
    message: string,
    public readonly residualArtifacts: string[] = [],
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  return 'OpenAI OAuth failed'
}

function isMissingPermissionRequestError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /permission request not found/i.test(message)
}

function extractSessionErrorMessage(payload: Record<string, unknown>): string {
  const raw = (payload as { message?: unknown; error?: unknown }).message ?? (payload as { error?: unknown }).error
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (raw instanceof Error && raw.message.trim()) return raw.message.trim()
  if (raw && typeof raw === 'object') {
    const nested = raw as { message?: unknown; error?: unknown }
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim()
    if (typeof nested.error === 'string' && nested.error.trim()) return nested.error.trim()
  }
  return 'The agent hit an error and stopped. Check the model/provider configuration and try again.'
}

function extractSessionErrorTime(payload: Record<string, unknown>): number | undefined {
  const time = (payload as { time?: { created?: unknown; completed?: unknown } }).time
  const created = time?.created ?? time?.completed
  return typeof created === 'number' ? created : undefined
}

export interface AgentSessionSummary {
  id: string
  workspaceId: string | null
  opencodeSessionId: string
  title: string | null
  status: AgentSessionStatus
  kind: AgentSessionKind
  workingDir: string | null
  createdAt: Date
  lastActivityAt: Date
}

export interface PendingApproval {
  id: string
  sessionId: string
  // The opencode tool callID this permission gates. Required so the FE
  // reconciler can re-attach a banner to the right tool part on reload —
  // without it, the entry sits in state.permissions but no ToolPart
  // calls permissionForCall() with a matching callID.
  callID?: string
  title: string
  pattern?: string | string[]
  metadata: Record<string, unknown>
  createdAt: number
}

export interface QuestionOptionInfo {
  label: string
  description?: string
}

export interface QuestionInfo {
  question: string
  header?: string
  options: QuestionOptionInfo[]
  multiple?: boolean
  custom?: boolean
}

export interface PendingQuestion {
  id: string
  sessionId: string
  questions: QuestionInfo[]
  tool?: { messageID: string; callID: string }
  createdAt: number
}

export interface TodoItem {
  id: string
  content: string
  status: string
  priority: string
}

export interface QueuedFollowUp {
  id: string
  text: string
  createdAt: number
}

export interface TranscriptEvent {
  seq?: number
  type:
    | 'message.updated'
    | 'message.part.updated'
    | 'permission.updated'
    | 'permission.replied'
    | 'session.busy'
    | 'session.idle'
    | 'session.error'
    | 'child.session.created'
    | 'question.asked'
    | 'question.replied'
    | 'question.rejected'
    | 'todo.updated'
  sessionId: string
  parentSessionId?: string
  payload: Record<string, unknown>
}

type TranscriptListener = (evt: TranscriptEvent) => void

const DURABLE_TRANSCRIPT_EVENT_TYPES = new Set<TranscriptEvent['type']>([
  // Kaivo overlay events that cannot be reconstructed from OpenCode messages.
  'session.error',
  'child.session.created',
  'permission.replied',
  'question.replied',
  'question.rejected',
])

type OpencodeSessionStatus = {
  type?: string
  message?: unknown
  error?: unknown
}

// One opencode `/event` SSE stream per project directory. opencode routes
// events for sessions bound to a non-default directory through that
// project's bus, so a single global subscription only sees the supervisor's
// CC_WORKING_DIR. We maintain one stream per distinct workingDir in use
// (empty string is the default project).
interface SubState {
  directory: string
  controller: AbortController | null
  running: boolean
  restartTimer: ReturnType<typeof setTimeout> | null
  listenerCount: number
}

export interface ModelInfo {
  providerID: string
  modelID: string
  label: string
}

function dbDate(iso: string): Date {
  return new Date(iso)
}

function parseReplayEvent(raw: unknown, seq: number): TranscriptEvent | null {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!value || typeof value !== 'object') return null
    const evt = value as Partial<TranscriptEvent>
    if (typeof evt.type !== 'string') return null
    if (typeof evt.sessionId !== 'string') return null
    if (!evt.payload || typeof evt.payload !== 'object') return null
    return { ...(evt as TranscriptEvent), seq: typeof evt.seq === 'number' ? evt.seq : seq }
  } catch {
    return null
  }
}

class AgentService {
  private client: OpencodeClient | null = null
  private listeners = new Set<TranscriptListener>()
  private eventObservers = new Set<TranscriptListener>()
  private sessionSendObservers = new Set<(sessionId: string) => void>()
  private sessionCreatedObservers = new Set<(session: AgentSessionSummary) => void>()
  private subs = new Map<string, SubState>()
  private pending = new Map<string, Map<string, PendingApproval>>() // opencodeSessionId -> permissionId
  private pendingQuestions = new Map<string, Map<string, PendingQuestion>>() // opencodeSessionId -> requestId
  private seqCounters = new Map<string, number>() // our session id -> next seq
  private parentByChild = new Map<string, string>()
  private childrenByParent = new Map<string, string[]>()
  private sessionModels = new Map<string, SessionModelSelection>()
  private contextLimitCache = new Map<string, ModelLimit>()
  private runningOpencodeSessions = new Set<string>()
  private userAbortedOpencodeSessions = new Set<string>()
  private queuedFollowUps = new Map<string, QueuedFollowUp[]>()
  private blockingNotificationKeys = new Set<string>()
  private surfacedStatusErrors = new Map<string, string>()
  private openAIOAuthStatus: OpenAIOAuthStatus = {
    state: 'idle',
    message: null,
    startedAt: null,
    completedAt: null,
  }

  async agentStatus(): Promise<{ ready: boolean; hasProvider: boolean }> {
    const ready = opencodeSupervisor.isReady()
    try {
      const providerEnv = await resolveProviderKeys()
      return { ready, hasProvider: Object.keys(providerEnv).length > 0 || (await hasOpenAIOAuthMarker()) }
    } catch (err) {
      if (err instanceof IdentityAuthError || err instanceof IdentityUnreachableError) {
        return { ready, hasProvider: false }
      }
      throw err
    }
  }

  /** Explicit user-triggered start (or restart). Propagates errors. */
  async startAgent(): Promise<void> {
    this.invalidateClient()
    try {
      // Bounce a running opencode first so the new spawn doesn't race the
      // old listener for the persisted port. Idempotent if nothing's up.
      await opencodeSupervisor.stopAndWait()
      await opencodeSupervisor.start()
      // Reset subscription so it connects to the fresh process.
      this.restartSubscription()
    } catch (err) {
      if (err instanceof OpenCodeError) {
        const code: AgentError['code'] =
          err.code === 'no_provider'
            ? 'no_provider'
            : err.code === 'not_ready'
              ? 'not_ready'
              : 'start_failed'
        throw new AgentError(code, err.message)
      }
      throw err
    }
  }

  async openAIOAuthStatusGet(): Promise<OpenAIOAuthStatus> {
    if (this.openAIOAuthStatus.state === 'idle' && (await hasOpenAIOAuthMarker())) {
      return {
        state: 'connected',
        message: 'OpenAI ChatGPT OAuth is connected.',
        startedAt: null,
        completedAt: null,
      }
    }
    return { ...this.openAIOAuthStatus }
  }

  async openAIOAuthStart(): Promise<{ url: string; deviceCode: string; methodIndex: number }> {
    this.invalidateClient()
    await opencodeSupervisor.stopAndWait()
    await opencodeSupervisor.start({ allowOpenAIOAuthOnly: true })
    const client = await this.getClient()
    const authMethods = await client.provider.auth({ throwOnError: true })
    const openaiMethods = (authMethods.data as Record<string, Array<{ type: string; label: string }>>).openai ?? []
    const methodIndex = openaiMethods.findIndex((m) => {
      const label = m.label.toLowerCase()
      return m.type === 'oauth' && label.includes('device code') && (label.includes('chatgpt') || label.includes('codex'))
    })
    if (methodIndex < 0) {
      throw new AgentError(
        'unavailable',
        'OpenAI ChatGPT Device Code OAuth is unavailable; the OpenCode OAuth plugin did not load a compatible method',
      )
    }

    const authorization = await client.provider.oauth.authorize({
      path: { id: 'openai' },
      body: { method: methodIndex },
      throwOnError: true,
    })
    const url = authorization.data.url?.trim()
    if (!url) {
      throw new AgentError('unavailable', 'OpenAI OAuth did not return a login URL')
    }
    const instructions = authorization.data.instructions?.trim()
    if (!instructions) {
      throw new AgentError('unavailable', 'OpenAI OAuth did not return device-code instructions')
    }
    const deviceCode = instructions.match(/code:\s*([a-z0-9-]+)/i)?.[1]?.toUpperCase()
    if (!deviceCode) {
      throw new AgentError('unavailable', 'OpenAI OAuth did not return a device code')
    }

    this.openAIOAuthStatus = {
      state: 'pending',
      message: 'Waiting for OpenAI browser login to complete.',
      startedAt: new Date(),
      completedAt: null,
    }

    void client.provider.oauth
      .callback({
        path: { id: 'openai' },
        body: { method: methodIndex },
        throwOnError: true,
      })
      .then((result) => {
        if (result.data !== true) throw new Error('OpenAI OAuth callback did not complete')
        void markOpenAIOAuthEnabled().catch((err) => logger.warn({ err }, 'failed to persist OpenAI OAuth marker'))
        this.openAIOAuthStatus = {
          state: 'connected',
          message: 'OpenAI ChatGPT OAuth is connected.',
          startedAt: this.openAIOAuthStatus.startedAt,
          completedAt: new Date(),
        }
      })
      .catch((err) => {
        this.openAIOAuthStatus = {
          state: 'failed',
          message: errorMessage(err),
          startedAt: this.openAIOAuthStatus.startedAt,
          completedAt: new Date(),
        }
      })

    return { url, deviceCode, methodIndex }
  }

  private async getClient(): Promise<OpencodeClient> {
    if (!opencodeSupervisor.isReady()) {
      // Lazy bootstrap: if not running, try once.
      await this.startAgent()
    }
    if (this.client) return this.client
    const ep = opencodeSupervisor.currentEndpoint()
    if (!ep) throw new AgentError('unavailable', 'opencode not running')
    const client = createOpencodeClient({
      baseUrl: `http://${ep.host}:${ep.port}`,
      headers: { Authorization: opencodeBasicAuthHeader(ep.password) },
    })
    this.client = client
    return client
  }

  private invalidateClient(): void {
    this.client = null
  }

  async sessionList(input: { workspaceId?: string; includeSubtasks?: boolean } = {}): Promise<AgentSessionSummary[]> {
    const query = db.select().from(agentSessions)
    const rows = input.workspaceId
      ? query
          .where(eq(agentSessions.workspaceId, input.workspaceId))
          .orderBy(desc(agentSessions.lastActivityAt))
          .all()
      : query.orderBy(desc(agentSessions.lastActivityAt)).all()
    return rows.filter((row) => input.includeSubtasks || row.kind !== 'subtask').map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId ?? null,
      opencodeSessionId: r.opencodeSessionId,
      title: r.title,
      status: r.status,
      kind: r.kind,
      workingDir: r.workingDir ?? null,
      createdAt: dbDate(r.createdAt),
      lastActivityAt: dbDate(r.lastActivityAt),
    }))
  }

  async workspaceChatSummary(input: { workspaceIds: string[] }): Promise<Array<{
    workspaceId: string
    chatCount: number
    runningCount: number
    pendingAttentionCount: number
    latestSessionId: string | null
    latestSessionTitle: string | null
    latestActivityAt: Date | null
  }>> {
    const out = []
    for (const workspaceId of input.workspaceIds) {
      const sessions = (await this.sessionList({ workspaceId })).filter((session) => session.status !== 'archived')
      let runningCount = 0
      let pendingAttentionCount = 0
      for (const session of sessions) {
        try {
          const status = await this.sessionStatus({ sessionId: session.id })
          if (status.running) runningCount++
          if (status.pendingApprovals.length > 0 || status.pendingQuestions.length > 0) pendingAttentionCount++
        } catch {
          // Ignore unavailable session status in sidebar summaries.
        }
      }
      const latest = sessions[0] ?? null
      out.push({
        workspaceId,
        chatCount: sessions.length,
        runningCount,
        pendingAttentionCount,
        latestSessionId: latest?.id ?? null,
        latestSessionTitle: latest?.title ?? null,
        latestActivityAt: latest?.lastActivityAt ?? null,
      })
    }
    return out
  }

  async sessionStart(input: {
    workspaceId?: string
    prompt?: string
    title?: string
    directory?: string
    model?: { providerID: string; modelID: string; variant?: ReasoningEffortVariant | null }
  }): Promise<AgentSessionSummary> {
    return this.sessionStartInternal({ ...input, kind: 'chat' })
  }

  async sessionStartInternal(input: {
    workspaceId?: string
    prompt?: string
    title?: string
    directory?: string
    model?: { providerID: string; modelID: string; variant?: ReasoningEffortVariant | null }
    kind: AgentSessionKind
  }): Promise<AgentSessionSummary> {
    const client = await this.getClient()
    const model = input.model ?? this.getDefaultModel()
    const create = await client.session.create({
      body: { title: input.title },
      ...directoryOpts(input.directory),
      throwOnError: true,
    })
    const ocSession = create.data
    const id = ulid().toLowerCase()
    const now = new Date()
    const derivedTitle =
      input.title ??
      (input.prompt ? truncatePromptForTitle(input.prompt) : undefined) ??
      ocSession.title ??
      null
    try {
      db.insert(agentSessions)
        .values({
          id,
          workspaceId: input.workspaceId ?? null,
          opencodeSessionId: ocSession.id,
          title: derivedTitle,
          status: 'active',
          kind: input.kind,
          workingDir: input.directory ?? null,
          selectedProviderId: input.model?.providerID ?? null,
          selectedModelId: input.model?.modelID ?? null,
          selectedModelVariant: input.model?.variant ?? null,
          createdAt: now.toISOString(),
          lastActivityAt: now.toISOString(),
        })
        .run()
    } catch (err) {
      try {
        await client.session.delete({
          path: { id: ocSession.id },
          ...directoryOpts(input.directory),
          throwOnError: true,
        })
      } catch {
        throw new AgentError(
          'start_failed',
          err instanceof Error ? err.message : 'failed to persist agent session',
          [`opencode_session:${ocSession.id}`],
        )
      }
      throw err
    }

    if (input.directory) recentFolderService.upsert(input.directory)

    if (input.model) {
      this.sessionModels.set(id, {
        providerID: input.model.providerID,
        modelID: input.model.modelID,
        variant: input.model.variant ?? null,
      })
    }

    if (input.prompt) {
      const prompt = input.prompt
      void client.session
        .promptAsync({
          path: { id: ocSession.id },
          body: promptBody({
            text: prompt,
            model,
            variant: input.model?.variant,
            sessionKind: input.kind,
            workspaceScoped: Boolean(input.workspaceId),
          }),
          ...directoryOpts(input.directory),
        })
        .catch((err) => logger.warn({ err, id }, 'session prompt failed'))
    }

    this.ensureSubscription(input.directory ?? '')
    this.upsertAgentRuntime({
      id,
      workspaceId: input.workspaceId ?? null,
      opencodeSessionId: ocSession.id,
      status: 'active',
      lastActivityAt: now.toISOString(),
    }, { running: Boolean(input.prompt), lastActivityAt: now })

    const summary: AgentSessionSummary = {
      id,
      workspaceId: input.workspaceId ?? null,
      opencodeSessionId: ocSession.id,
      title: derivedTitle,
      status: 'active',
      kind: input.kind,
      workingDir: input.directory ?? null,
      createdAt: now,
      lastActivityAt: now,
    }
    for (const observer of this.sessionCreatedObservers) observer(summary)
    return summary
  }

  async sessionRename(input: { sessionId: string; title: string }): Promise<AgentSessionSummary> {
    const row = await this.requireSession(input.sessionId)
    const title = input.title.trim().slice(0, 200)
    if (!title) throw new AgentError('not_found', 'title cannot be empty')
    const now = new Date()
    db.update(agentSessions)
      .set({ title, lastActivityAt: now.toISOString() })
      .where(eq(agentSessions.id, row.id))
      .run()
    this.upsertAgentRuntime(row, { lastActivityAt: now })
    return {
      id: row.id,
      workspaceId: row.workspaceId ?? null,
      opencodeSessionId: row.opencodeSessionId,
      title,
      status: row.status,
      kind: row.kind,
      workingDir: row.workingDir ?? null,
      createdAt: dbDate(row.createdAt),
      lastActivityAt: now,
    }
  }

  async listModels(): Promise<{
    models: ModelInfo[]
    defaultProviderID: string | null
    defaultModelID: string | null
  }> {
    const client = await this.getClient()
    const res = await client.config.providers({ throwOnError: true })
    const body = res.data as {
      providers: Array<{
        id: string
        name?: string
        models: Record<string, { id: string; name?: string }>
      }>
      default: Record<string, string>
    }
    const models: ModelInfo[] = []
    for (const p of body.providers) {
      for (const m of Object.values(p.models ?? {})) {
        models.push({ providerID: p.id, modelID: m.id, label: `${p.id}/${m.id}` })
      }
    }
    models.sort((a, b) => a.label.localeCompare(b.label))
    const defaultModel = this.getDefaultModel()
    return {
      models,
      defaultProviderID: defaultModel.providerID,
      defaultModelID: defaultModel.modelID,
    }
  }

  getDefaultModel(): { providerID: string; modelID: string } {
    const meta = getMeta()
    if (meta.defaultProviderId && meta.defaultModelId) {
      return { providerID: meta.defaultProviderId, modelID: meta.defaultModelId }
    }
    return { ...BUILTIN_DEFAULT_MODEL }
  }

  setDefaultModel(model: { providerID: string; modelID: string }): void {
    setEnvDefaultModel(model.providerID, model.modelID)
  }

  async setSessionModel(
    sessionId: string,
    model: { providerID: string; modelID: string } | null,
  ): Promise<void> {
    const current = await this.getSessionModel(sessionId)
    const next: SessionModelSelection = {
      providerID: model?.providerID ?? null,
      modelID: model?.modelID ?? null,
      variant: current?.variant ?? null,
    }
    this.sessionModels.set(sessionId, next)
    db.update(agentSessions)
      .set({
        selectedProviderId: next.providerID,
        selectedModelId: next.modelID,
      })
      .where(eq(agentSessions.id, sessionId))
      .run()
  }

  async setSessionModelVariant(
    sessionId: string,
    variant: ReasoningEffortVariant | null,
  ): Promise<void> {
    const current = await this.getSessionModel(sessionId)
    const next: SessionModelSelection = {
      providerID: current?.providerID ?? null,
      modelID: current?.modelID ?? null,
      variant,
    }
    this.sessionModels.set(sessionId, next)
    db.update(agentSessions)
      .set({ selectedModelVariant: variant })
      .where(eq(agentSessions.id, sessionId))
      .run()
  }

  async getSessionModel(
    sessionId: string,
  ): Promise<SessionModelSelection | null> {
    const cached = this.sessionModels.get(sessionId)
    if (cached) return cached
    const rows = db
      .select({
        providerID: agentSessions.selectedProviderId,
        modelID: agentSessions.selectedModelId,
        variant: agentSessions.selectedModelVariant,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1)
      .all()
    const r = rows[0]
    if (!r) return null
    const hydrated: SessionModelSelection = {
      providerID: r.providerID ?? null,
      modelID: r.modelID ?? null,
      variant: isReasoningEffortVariant(r.variant) ? r.variant : null,
    }
    if (!hydrated.providerID && !hydrated.modelID && !hydrated.variant) return null
    this.sessionModels.set(sessionId, hydrated)
    return hydrated
  }

  private async getModelContextLimit(
    client: OpencodeClient,
    providerID: string,
    modelID: string,
  ): Promise<number | null> {
    const key = `${providerID}/${modelID}`
    const cached = this.contextLimitCache.get(key)
    if (cached !== undefined) return practicalContextUsageLimit(cached)
    try {
      const res = await client.config.providers({ throwOnError: true })
      const body = res.data as {
        providers: Array<{
          id: string
          models: Record<string, { id: string; limit?: ModelLimit }>
        }>
      }
      for (const p of body.providers) {
        for (const m of Object.values(p.models ?? {})) {
          const k = `${p.id}/${m.id}`
          const limit = practicalContextUsageLimit(m.limit)
          if (limit && m.limit) this.contextLimitCache.set(k, m.limit)
        }
      }
      return practicalContextUsageLimit(this.contextLimitCache.get(key))
    } catch {
      return null
    }
  }

  async listCommands(): Promise<
    Array<{ name: string; description?: string; template?: string; agent?: string; model?: string }>
  > {
    const client = await this.getClient()
    const res = await client.command.list({ throwOnError: true })
    return (res.data ?? []) as Array<{
      name: string
      description?: string
      template?: string
      agent?: string
      model?: string
    }>
  }

  async runCommand(input: { sessionId: string; command: string; arguments: string }): Promise<void> {
    const { row, client, model, variant, dirOpts } = await this.sessionContext(input.sessionId)
    this.assertSessionActive(row)
    this.ensureSubscription(row.workingDir ?? '')
    this.emitTranscriptEvent(row.opencodeSessionId, 'session.busy', { sessionID: row.opencodeSessionId })
    await client.session.command({
      path: { id: row.opencodeSessionId },
      body: {
        command: input.command,
        arguments: input.arguments,
        model: `${model.providerID}/${model.modelID}`,
        ...(variant ? { variant } : {}),
      },
      ...dirOpts,
      throwOnError: true,
    })
    db.update(agentSessions)
      .set({ lastActivityAt: new Date().toISOString() })
      .where(eq(agentSessions.id, row.id))
      .run()
  }

  async sessionSetStatus(input: {
    sessionId: string
    status: 'active' | 'archived'
  }): Promise<AgentSessionSummary> {
    const row = await this.requireSession(input.sessionId)
    const now = new Date()
    db.update(agentSessions)
      .set({ status: input.status, lastActivityAt: now.toISOString() })
      .where(eq(agentSessions.id, row.id))
      .run()
    if (input.status === 'archived') {
      this.queuedFollowUps.delete(row.opencodeSessionId)
      getAgentRuntimeRealtime().delete(AGENT_SESSION_RUNTIME_TABLE, row.id)
    } else {
      this.upsertAgentRuntime({ ...row, status: input.status }, { lastActivityAt: now })
    }
    return {
      id: row.id,
      workspaceId: row.workspaceId ?? null,
      opencodeSessionId: row.opencodeSessionId,
      title: row.title,
      status: input.status,
      kind: row.kind,
      workingDir: row.workingDir ?? null,
      createdAt: dbDate(row.createdAt),
      lastActivityAt: now,
    }
  }

  async sessionConvertToDispatch(input: { sessionId: string }): Promise<AgentSessionSummary> {
    const row = await this.requireSession(input.sessionId)
    if (row.status !== 'active') {
      throw new AgentError('invalid_state', 'reopen the chat before converting it to a dispatch session')
    }
    if (row.kind !== 'chat') {
      throw new AgentError('invalid_state', 'only ordinary chat sessions can be converted to dispatch sessions')
    }
    if (!row.workspaceId) {
      throw new AgentError('invalid_state', 'a workspace chat is required for dispatch orchestration')
    }

    const now = new Date()
    db.update(agentSessions)
      .set({ kind: 'dispatch', lastActivityAt: now.toISOString() })
      .where(eq(agentSessions.id, row.id))
      .run()

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      opencodeSessionId: row.opencodeSessionId,
      title: row.title,
      status: row.status,
      kind: 'dispatch',
      workingDir: row.workingDir ?? null,
      createdAt: dbDate(row.createdAt),
      lastActivityAt: now,
    }
  }

  async sessionSend(input: { sessionId: string; message: string }): Promise<{ queued: boolean; queuedMessage?: QueuedFollowUp }> {
    const { row, client, model, variant, dirOpts } = await this.sessionContext(input.sessionId)
    this.assertSessionActive(row)
    this.ensureSubscription(row.workingDir ?? '')
    const running = await this.isOpencodeSessionRunning(client, row.opencodeSessionId, dirOpts)
    const queue = this.queuedFollowUps.get(row.opencodeSessionId) ?? []
    if (running || queue.length > 0) {
      const queuedMessage = { id: ulid(), text: input.message, createdAt: Date.now() }
      queue.push(queuedMessage)
      this.queuedFollowUps.set(row.opencodeSessionId, queue)
      for (const observer of this.sessionSendObservers) observer(row.id)
      return { queued: true, queuedMessage }
    }
    await this.sendPromptToOpencode({ row, client, model, variant, dirOpts, message: input.message })
    const nextTitle =
      !row.title || /^New session - /.test(row.title) ? truncatePromptForTitle(input.message) : row.title
    db.update(agentSessions)
      .set({
        title: nextTitle,
        lastActivityAt: new Date().toISOString(),
      })
      .where(eq(agentSessions.id, row.id))
      .run()
    for (const observer of this.sessionSendObservers) observer(row.id)
    return { queued: false }
  }

  private assertSessionActive(row: { status: string }): void {
    if (row.status !== 'active') throw new AgentError('invalid_state', 'session is archived; reopen it before sending')
  }

  async sessionMessages(
    sessionId: string,
  ): Promise<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>> {
    const { row } = await this.sessionContext(sessionId)
    const messages = await this.openCodeSessionMessages(sessionId)
    return this.withPersistedSessionErrors(row.id, row.opencodeSessionId, messages)
  }

  async openCodeSessionMessages(
    sessionId: string,
  ): Promise<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>> {
    const { row, client, dirOpts } = await this.sessionContext(sessionId)
    const res = await client.session.messages({
      path: { id: row.opencodeSessionId },
      ...dirOpts,
      throwOnError: true,
    })
    return (res.data ?? []) as Array<{
      info: Record<string, unknown>
      parts: Array<Record<string, unknown>>
    }>
  }

  private withPersistedSessionErrors(
    sessionId: string,
    opencodeSessionId: string,
    messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>,
  ): Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> {
    const out = [...messages]
    for (const evt of this.transcriptReplayRows(sessionId, 0)) {
      if (evt.type !== 'session.error') continue
      if (evt.sessionId !== opencodeSessionId) continue
      const created = extractSessionErrorTime(evt.payload) ?? evt.seq ?? Date.now()
      const message = extractSessionErrorMessage(evt.payload)
      const messageID = `session-error:${opencodeSessionId}:${evt.seq ?? created}`
      out.push({
        info: {
          id: messageID,
          role: 'assistant',
          sessionID: opencodeSessionId,
          time: { created, completed: created },
          synthetic: true,
        },
        parts: [
          {
            id: `${messageID}:part`,
            type: 'session-error',
            messageID,
            sessionID: opencodeSessionId,
            title: 'Agent error',
            message,
            time: { start: created, end: created },
          },
        ],
      })
    }
    return out
  }

  async childTranscripts(sessionId: string): Promise<
    Array<{
      sessionID: string
      parentID: string
      title: string | null
      createdAt: number
      messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
    }>
  > {
    const { row, client, dirOpts } = await this.sessionContext(sessionId)
    const all = await client.session.list({ ...dirOpts, throwOnError: true })
    const sessions = (all.data ?? []) as Array<{
      id: string
      parentID?: string
      title?: string
      time?: { created?: number }
    }>
    const children = sessions
      .filter((s) => s.parentID === row.opencodeSessionId)
      .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
    const list = this.childrenByParent.get(row.opencodeSessionId) ?? []
    for (const c of children) {
      if (!this.parentByChild.has(c.id)) this.parentByChild.set(c.id, row.opencodeSessionId)
      if (!list.includes(c.id)) list.push(c.id)
    }
    this.childrenByParent.set(row.opencodeSessionId, list)
    const out = await Promise.all(
      children.map(async (c) => {
        const res = await client.session
          .messages({ path: { id: c.id }, ...dirOpts, throwOnError: true })
          .catch(() => null)
        const messages = (res?.data ?? []) as Array<{
          info: Record<string, unknown>
          parts: Array<Record<string, unknown>>
        }>
        return {
          sessionID: c.id,
          parentID: row.opencodeSessionId,
          title: c.title ?? null,
          createdAt: c.time?.created ?? 0,
          messages,
        }
      }),
    )
    return out
  }

  async sessionStatus(input: { sessionId: string }): Promise<{
    session: AgentSessionSummary
    pendingApprovals: PendingApproval[]
    pendingQuestions: PendingQuestion[]
    todos: TodoItem[]
    running: boolean
    contextUsage: { used: number; limit: number } | null
    queuedMessages: QueuedFollowUp[]
  }> {
    const { row, client, dirOpts } = await this.sessionContext(input.sessionId)
    const relatedOpencodeSessionIds = this.relatedOpencodeSessionIds(row.opencodeSessionId)
    const pending = relatedOpencodeSessionIds.flatMap((id) => [...(this.pending.get(id)?.values() ?? [])])
    let questions = relatedOpencodeSessionIds.flatMap((id) => [...(this.pendingQuestions.get(id)?.values() ?? [])])
    if (questions.length === 0) {
      try {
        const fresh = await this.questionList()
        const related = new Set(relatedOpencodeSessionIds)
        questions = fresh.filter((q) => related.has(q.sessionId))
        if (questions.length > 0) {
          for (const q of questions) {
            let byReq = this.pendingQuestions.get(q.sessionId)
            if (!byReq) {
              byReq = new Map()
              this.pendingQuestions.set(q.sessionId, byReq)
            }
            byReq.set(q.id, q)
          }
        }
      } catch {
        // opencode unreachable — leave empty
      }
    }
    let todos: TodoItem[] = []
    try {
      const res = await client.session.todo({
        path: { id: row.opencodeSessionId },
        ...dirOpts,
        throwOnError: true,
      })
      todos = ((res.data ?? []) as TodoItem[]).map((t) => ({
        id: t.id,
        content: t.content,
        status: t.status,
        priority: t.priority,
      }))
    } catch {
      // empty
    }
    let running = false
    try {
      const statusRes = await client.session.status({ ...dirOpts, throwOnError: true })
      const statuses = statusRes.data as Record<string, OpencodeSessionStatus>
      const st = statuses[row.opencodeSessionId]
      running = st?.type === 'busy'
      if (st?.type === 'retry') await this.handleRetryStatus(row.opencodeSessionId, st, client, dirOpts)
      else this.surfacedStatusErrors.delete(row.opencodeSessionId)
    } catch {
      // opencode down
    }
    let contextUsage: { used: number; limit: number } | null = null
    try {
      const msgRes = await client.session.messages({
        path: { id: row.opencodeSessionId },
        ...directoryQueryOpts(row.workingDir, { limit: RECENT_MESSAGE_CONTEXT_LIMIT }),
        throwOnError: true,
      })
      type TokenInfo = { input?: number; total?: number; cache?: { read?: number } }
      const msgs = (msgRes.data ?? []) as Array<{
        info?: {
          role?: string
          tokens?: TokenInfo
          providerID?: string
          modelID?: string
        }
        parts?: Array<{
          type?: string
          tokens?: TokenInfo
        }>
      }>
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        const info = msg?.info
        if (info?.role !== 'assistant') continue
        let tokens: TokenInfo | undefined
        const steps = (msg?.parts ?? []).filter((p) => p.type === 'step-finish')
        if (steps.length > 0) tokens = steps[steps.length - 1]!.tokens
        if (!tokens) tokens = info.tokens
        const contextTokens = tokens?.total ?? ((tokens?.input ?? 0) + (tokens?.cache?.read ?? 0))
        if (!contextTokens) continue
        const provID = info.providerID
        const modID = info.modelID
        if (provID && modID) {
          const limit = await this.getModelContextLimit(client, provID, modID)
          if (limit) {
            contextUsage = { used: contextTokens, limit }
          }
        }
        break
      }
    } catch {
      // ignore
    }
    return {
      session: {
        id: row.id,
        workspaceId: row.workspaceId ?? null,
        opencodeSessionId: row.opencodeSessionId,
        title: row.title,
        status: row.status,
        kind: row.kind,
        workingDir: row.workingDir ?? null,
        createdAt: dbDate(row.createdAt),
        lastActivityAt: dbDate(row.lastActivityAt),
      },
      pendingApprovals: pending,
      pendingQuestions: questions,
      todos,
      running,
      contextUsage,
      queuedMessages: [...(this.queuedFollowUps.get(row.opencodeSessionId) ?? [])],
    }
  }

  async sessionAnswerQuestion(input: {
    sessionId: string
    requestId: string
    answers: string[][]
  }): Promise<void> {
    const ctx = await this.sessionContext(input.sessionId)
    await ctx.fetch(`/question/${encodeURIComponent(input.requestId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ answers: input.answers }),
    })
    this.deletePendingQuestion(ctx.row.opencodeSessionId, input.requestId)
    this.upsertAgentRuntime(ctx.row)
  }

  async sessionRejectQuestion(input: {
    sessionId: string
    requestId: string
  }): Promise<void> {
    const ctx = await this.sessionContext(input.sessionId)
    await ctx.fetch(`/question/${encodeURIComponent(input.requestId)}/reject`, {
      method: 'POST',
    })
    this.deletePendingQuestion(ctx.row.opencodeSessionId, input.requestId)
    this.upsertAgentRuntime(ctx.row)
  }

  private async questionList(): Promise<PendingQuestion[]> {
    const res = await this.opencodeFetch('/question', { method: 'GET' })
    const data = (await res.json()) as Array<{
      id: string
      sessionID: string
      questions?: QuestionInfo[]
      tool?: { messageID: string; callID: string }
    }>
    return data.map((q) => ({
      id: q.id,
      sessionId: q.sessionID,
      questions: Array.isArray(q.questions) ? q.questions : [],
      tool: q.tool,
      createdAt: Date.now(),
    }))
  }

  private async opencodeFetch(
    pth: string,
    init: RequestInit,
    directory?: string | null,
  ): Promise<Response> {
    const ep = opencodeSupervisor.currentEndpoint()
    if (!ep) throw new AgentError('unavailable', 'opencode not running')
    const headers = new Headers(init.headers)
    headers.set('Authorization', opencodeBasicAuthHeader(ep.password))
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const url = new URL(`http://${ep.host}:${ep.port}${pth}`)
    if (directory) {
      url.searchParams.set('directory', directory)
      headers.set('x-opencode-directory', directory)
    }
    const res = await fetch(url.toString(), { ...init, headers })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new AgentError(
        'unavailable',
        `opencode ${init.method ?? 'GET'} ${pth} → ${res.status}: ${body.slice(0, 200)}`,
      )
    }
    return res
  }

  async sessionAbort(input: { sessionId: string }): Promise<void> {
    const { row, client, dirOpts } = await this.sessionContext(input.sessionId)
    this.queuedFollowUps.delete(row.opencodeSessionId)
    this.userAbortedOpencodeSessions.add(row.opencodeSessionId)
    try {
      await client.session.abort({
        path: { id: row.opencodeSessionId },
        ...dirOpts,
        throwOnError: true,
      })
    } catch (err) {
      this.userAbortedOpencodeSessions.delete(row.opencodeSessionId)
      throw err
    }
  }

  async sessionRespond(input: {
    sessionId: string
    permissionId: string
    response: 'once' | 'always' | 'reject'
  }): Promise<void> {
    const { row, fetch } = await this.sessionContext(input.sessionId)
    const targetOpencodeSessionId = this.findPermissionSession(row.opencodeSessionId, input.permissionId) ?? row.opencodeSessionId
    try {
      await fetch(`/permission/${encodeURIComponent(input.permissionId)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ reply: input.response }),
      })
    } catch (err) {
      if (!isMissingPermissionRequestError(err)) throw err
    }
    this.clearPermissionRequest(row.opencodeSessionId, targetOpencodeSessionId, input.permissionId)
    this.upsertAgentRuntime(row)
  }

  resolveRootOpencodeSessionId(opencodeSessionId: string): string {
    let current = opencodeSessionId
    const seen = new Set<string>()
    while (!seen.has(current)) {
      seen.add(current)
      const parent = this.parentByChild.get(current)
      if (!parent) return current
      current = parent
    }
    return current
  }

  async transcriptReplay(sessionId: string, sinceSeq = 0): Promise<TranscriptEvent[]> {
    const row = await this.requireSession(sessionId)
    return this.transcriptReplayRows(row.id, sinceSeq)
  }

  async transcriptLatestSeq(sessionId: string): Promise<{ seq: number }> {
    const row = await this.requireSession(sessionId)
    const latest = db
      .select({ seq: agentTranscripts.seq })
      .from(agentTranscripts)
      .where(eq(agentTranscripts.sessionId, row.id))
      .orderBy(desc(agentTranscripts.seq))
      .limit(1)
      .all()[0]
    return { seq: latest?.seq ?? 0 }
  }

  subscribeTranscript(sessionId: string, fn: TranscriptListener, sinceSeq = 0): () => void {
    let unsubscribed = false
    let innerUnsub: (() => void) | null = null
    void (async () => {
      const row = await this.requireSession(sessionId).catch(() => null)
      if (!row || unsubscribed) return
      const directory = row.workingDir ?? ''
      const state = this.getOrCreateSubState(directory)
      state.listenerCount++
      this.ensureSubscription(directory)
      let replaying = true
      const pending: TranscriptEvent[] = []
      const emittedSeqs = new Set<number>()
      const emit = (evt: TranscriptEvent) => {
        if (evt.seq !== undefined) {
          if (emittedSeqs.has(evt.seq)) return
          emittedSeqs.add(evt.seq)
        }
        if (replaying) pending.push(evt)
        else fn(evt)
      }
      const wrapper: TranscriptListener = (evt) => {
        if (evt.sessionId === row.opencodeSessionId) {
          emit(evt)
          return
        }
        if (this.parentByChild.get(evt.sessionId) === row.opencodeSessionId) {
          emit({ ...evt, parentSessionId: row.opencodeSessionId })
        }
      }
      this.listeners.add(wrapper)
      innerUnsub = () => {
        this.listeners.delete(wrapper)
        const s = this.subs.get(directory)
        if (!s) return
        s.listenerCount--
        if (s.listenerCount <= 0) this.stopSubscription(directory)
      }
      for (const evt of this.transcriptReplayRows(row.id, sinceSeq)) emit(evt)
      replaying = false
      pending.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      for (const evt of pending) {
        if (unsubscribed) return
        fn(evt)
      }
      if (unsubscribed) innerUnsub()
    })()
    return () => {
      unsubscribed = true
      innerUnsub?.()
    }
  }

  subscribeEvents(fn: TranscriptListener): () => void {
    this.eventObservers.add(fn)
    return () => this.eventObservers.delete(fn)
  }

  subscribeSessionSends(fn: (sessionId: string) => void): () => void {
    this.sessionSendObservers.add(fn)
    return () => this.sessionSendObservers.delete(fn)
  }

  subscribeSessionCreated(fn: (session: AgentSessionSummary) => void): () => void {
    this.sessionCreatedObservers.add(fn)
    return () => this.sessionCreatedObservers.delete(fn)
  }

  retainEventStream(directory: string): () => void {
    const state = this.getOrCreateSubState(directory)
    state.listenerCount++
    this.ensureSubscription(directory)
    return () => {
      const current = this.subs.get(directory)
      if (!current) return
      current.listenerCount--
      if (current.listenerCount <= 0) this.stopSubscription(directory)
    }
  }

  private getOrCreateSubState(directory: string): SubState {
    let state = this.subs.get(directory)
    if (!state) {
      state = {
        directory,
        controller: null,
        running: false,
        restartTimer: null,
        listenerCount: 0,
      }
      this.subs.set(directory, state)
    }
    return state
  }

  private ensureSubscription(directory: string = ''): void {
    const state = this.getOrCreateSubState(directory)
    if (state.running) return
    state.running = true
    void this.runEventLoop(directory).finally(() => {
      const s = this.subs.get(directory)
      if (s) s.running = false
    })
  }

  private stopSubscription(directory: string): void {
    const state = this.subs.get(directory)
    if (!state) return
    if (state.controller) {
      try {
        state.controller.abort()
      } catch {
        // ignore
      }
      state.controller = null
    }
    if (state.restartTimer) {
      clearTimeout(state.restartTimer)
      state.restartTimer = null
    }
  }

  /** Restart all subscriptions (after opencode restart, etc.). */
  private restartSubscription(): void {
    for (const state of this.subs.values()) {
      if (state.controller) {
        try {
          state.controller.abort()
        } catch {
          // ignore
        }
        state.controller = null
      }
    }
    for (const state of this.subs.values()) {
      if (state.listenerCount > 0) this.ensureSubscription(state.directory)
    }
  }

  private async runEventLoop(directory: string): Promise<void> {
    let client: OpencodeClient
    try {
      client = await this.getClient()
    } catch (err) {
      logger.warn({ err, directory }, 'agent subscribe: client init failed')
      this.scheduleRestart(directory)
      return
    }
    const controller = new AbortController()
    const state = this.subs.get(directory)
    if (state) state.controller = controller
    try {
      const stream = await client.event.subscribe({
        signal: controller.signal,
        ...(directory ? { query: { directory } } : {}),
      })
      let endedCleanly = true
      for await (const evt of stream.stream) {
        if (controller.signal.aborted) {
          endedCleanly = false
          break
        }
        await this.handleEvent(evt)
      }
      if (endedCleanly && !controller.signal.aborted) {
        logger.warn({ directory }, 'agent event stream ended')
        this.scheduleRestart(directory)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        logger.warn({ err, directory }, 'agent event stream failed')
        this.invalidateClient()
        this.scheduleRestart(directory)
      }
    } finally {
      const s = this.subs.get(directory)
      if (s && s.controller === controller) s.controller = null
    }
  }

  private scheduleRestart(directory: string): void {
    const state = this.subs.get(directory)
    if (!state) return
    if (state.listenerCount === 0) return
    if (state.restartTimer) return
    state.restartTimer = setTimeout(() => {
      const s = this.subs.get(directory)
      if (s) s.restartTimer = null
      if (s && s.listenerCount > 0) this.ensureSubscription(directory)
    }, 2_000)
    state.restartTimer.unref?.()
  }

  private async handleEvent(raw: unknown): Promise<void> {
    const ev = raw as { type?: string; properties?: Record<string, unknown> }
    let type = ev?.type
    const props = ev?.properties ?? {}
    if (!type) return

    if (type === 'permission.asked') type = 'permission.updated'

    if (type === 'permission.updated') {
      const p = props as {
        id?: string
        callID?: string
        tool?: { callID?: string; messageID?: string }
        patterns?: string[]
        pattern?: string | string[]
        title?: string
        permission?: string
        metadata?: Record<string, unknown>
        time?: { created?: number }
      }
      if (!p.callID && p.tool?.callID) p.callID = p.tool.callID
      if (!p.pattern && Array.isArray(p.patterns)) {
        p.pattern = p.patterns.length === 1 ? p.patterns[0]! : p.patterns
      }
      if (!p.title) {
        const kind = p.permission ?? 'permission'
        const pat = Array.isArray(p.pattern) ? p.pattern.join(', ') : p.pattern
        p.title = pat ? `${kind}: ${pat}` : `${kind} requested`
      }
      if (!p.time) p.time = { created: Date.now() }
    }

    if (type === 'session.created' || type === 'session.updated') {
      const info = (props as { info?: { id?: string; parentID?: string } }).info
      const childId = info?.id
      const parentId = info?.parentID
      if (childId && parentId) {
        const known = this.parentByChild.get(childId)
        if (!known) {
          this.parentByChild.set(childId, parentId)
          const list = this.childrenByParent.get(parentId) ?? []
          if (!list.includes(childId)) {
            list.push(childId)
            this.childrenByParent.set(parentId, list)
          }
          const fanout = this.recordReplayEvent(parentId, {
            type: 'child.session.created',
            sessionId: childId,
            parentSessionId: parentId,
            payload: { info: info as Record<string, unknown> },
          })
          for (const l of this.listeners) {
            try {
              l(fanout)
            } catch (err) {
              logger.warn({ err }, 'transcript listener threw')
            }
          }
        }
      }
      return
    }

    let ocSessionId: string | undefined
    if (type === 'message.updated') {
      ocSessionId = (props.info as { sessionID?: string } | undefined)?.sessionID
    } else if (type === 'message.part.updated') {
      ocSessionId = (props.part as { sessionID?: string } | undefined)?.sessionID
    } else if (
      type === 'permission.updated' ||
      type === 'permission.replied' ||
      type === 'session.busy' ||
      type === 'session.idle' ||
      type === 'session.error' ||
      type === 'question.asked' ||
      type === 'question.replied' ||
      type === 'question.rejected' ||
      type === 'todo.updated'
    ) {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else {
      return
    }

    if (!ocSessionId) return
    if (type === 'session.busy' || type === 'session.idle') this.userAbortedOpencodeSessions.delete(ocSessionId)
    if (type === 'session.error' && this.userAbortedOpencodeSessions.delete(ocSessionId)) {
      type = 'session.idle'
    }
    const runtimeRunning =
      type === 'session.busy' || type === 'message.part.updated'
        ? true
        : type === 'session.idle' || type === 'session.error'
          ? false
          : undefined
    const hadRunningRun = this.runningOpencodeSessions.has(ocSessionId)
    if (runtimeRunning === true) this.runningOpencodeSessions.add(ocSessionId)
    if (runtimeRunning === false) this.runningOpencodeSessions.delete(ocSessionId)

    if (!this.parentByChild.has(ocSessionId)) {
      if (type === 'session.idle' || type === 'session.error') {
        if (hadRunningRun && type === 'session.idle') {
          const hasQueuedFollowUp = (this.queuedFollowUps.get(ocSessionId)?.length ?? 0) > 0
          if (hasQueuedFollowUp) setTimeout(() => void this.drainQueuedFollowUps(ocSessionId), 0)
          else if (!this.isSubtaskOpencodeSession(ocSessionId)) void this.createFinishedNotification(ocSessionId)
        }
        if (type === 'session.error') {
          const message = String((props as { error?: unknown; message?: unknown }).message ?? (props as { error?: unknown }).error ?? 'The agent hit an error and needs attention.')
          void this.createBlockingNotification(ocSessionId, 'error', 'error', 'Agent error', message)
        }
      }
    }

    if (type === 'permission.updated') {
      const p = props as unknown as {
        id: string
        sessionID: string
        callID?: string
        title?: string
        pattern?: string | string[]
        metadata?: Record<string, unknown>
        time?: { created?: number }
      }
      let byPerm = this.pending.get(ocSessionId)
      if (!byPerm) {
        byPerm = new Map()
        this.pending.set(ocSessionId, byPerm)
      }
      const title = p.title ?? 'Approval required'
      byPerm.set(p.id, {
        id: p.id,
        sessionId: p.sessionID,
        callID: p.callID ?? (p.metadata as { callID?: string } | undefined)?.callID,
        title,
        pattern: p.pattern,
        metadata: p.metadata ?? {},
        createdAt: p.time?.created ?? Date.now(),
      })
      const rootOpencodeSessionId = this.resolveRootOpencodeSessionId(ocSessionId)
      void this.createBlockingNotification(rootOpencodeSessionId, `permission:${ocSessionId}:${p.id}`, 'permission', 'Approval required', title)
    } else if (type === 'permission.replied') {
      const p = props as { permissionID?: string; requestID?: string }
      const permissionId = p.permissionID ?? p.requestID
      if (permissionId) this.pending.get(ocSessionId)?.delete(permissionId)
      if (permissionId) this.blockingNotificationKeys.delete(`${this.resolveRootOpencodeSessionId(ocSessionId)}:permission:${ocSessionId}:${permissionId}`)
    } else if (type === 'question.asked') {
      const q = props as unknown as {
        id?: string
        sessionID: string
        questions?: QuestionInfo[]
        tool?: { messageID: string; callID: string }
      }
      if (q.id) {
        let byReq = this.pendingQuestions.get(ocSessionId)
        if (!byReq) {
          byReq = new Map()
          this.pendingQuestions.set(ocSessionId, byReq)
        }
        byReq.set(q.id, {
          id: q.id,
          sessionId: q.sessionID,
          questions: Array.isArray(q.questions) ? q.questions : [],
          tool: q.tool,
          createdAt: Date.now(),
        })
        const question = Array.isArray(q.questions) ? q.questions[0]?.question : undefined
        const rootOpencodeSessionId = this.resolveRootOpencodeSessionId(ocSessionId)
        void this.createBlockingNotification(rootOpencodeSessionId, `question:${ocSessionId}:${q.id}`, 'question', 'Question asked', question ?? 'The agent needs an answer to continue.')
      }
    } else if (type === 'question.replied' || type === 'question.rejected') {
      const q = props as { requestID?: string }
      if (q.requestID) this.pendingQuestions.get(ocSessionId)?.delete(q.requestID)
      if (q.requestID) this.blockingNotificationKeys.delete(`${this.resolveRootOpencodeSessionId(ocSessionId)}:question:${ocSessionId}:${q.requestID}`)
    }
    const rootOpencodeSessionId = this.resolveRootOpencodeSessionId(ocSessionId)
    const rootRunning = runtimeRunning === undefined
      ? undefined
      : this.relatedOpencodeSessionIds(rootOpencodeSessionId).some((id) => this.runningOpencodeSessions.has(id))
    this.upsertAgentRuntimeForOpencode(rootOpencodeSessionId, { running: rootRunning, lastActivityAt: new Date() })

    const evt = await this.recordReplayEvent(ocSessionId, {
      type: type as TranscriptEvent['type'],
      sessionId: ocSessionId,
      payload: props,
    })
    for (const l of this.listeners) {
      try {
        l(evt)
      } catch (err) {
        logger.warn({ err }, 'transcript listener threw')
      }
    }
    for (const observer of this.eventObservers) {
      try {
        observer(evt)
      } catch (err) {
        logger.warn({ err }, 'agent event observer threw')
      }
    }
  }

  private emitTranscriptEvent(
    opencodeSessionId: string,
    type: TranscriptEvent['type'],
    payload: Record<string, unknown>,
  ): TranscriptEvent {
    if (type === 'session.busy') this.surfacedStatusErrors.delete(opencodeSessionId)
    const running = type === 'session.busy' || type === 'message.part.updated'
      ? true
      : type === 'session.idle' || type === 'session.error'
        ? false
        : undefined
    if (running === true) this.runningOpencodeSessions.add(opencodeSessionId)
    if (running === false) this.runningOpencodeSessions.delete(opencodeSessionId)
    const rootOpencodeSessionId = this.resolveRootOpencodeSessionId(opencodeSessionId)
    const rootRunning = running === undefined
      ? undefined
      : this.relatedOpencodeSessionIds(rootOpencodeSessionId).some((id) => this.runningOpencodeSessions.has(id))
    this.upsertAgentRuntimeForOpencode(rootOpencodeSessionId, { running: rootRunning, lastActivityAt: new Date() })
    const evt = this.recordReplayEvent(opencodeSessionId, {
      type,
      sessionId: opencodeSessionId,
      payload,
    })
    for (const l of this.listeners) {
      try {
        l(evt)
      } catch (err) {
        logger.warn({ err }, 'transcript listener threw')
      }
    }
    for (const observer of this.eventObservers) {
      try {
        observer(evt)
      } catch (err) {
        logger.warn({ err }, 'agent event observer threw')
      }
    }
    return evt
  }

  private async handleRetryStatus(
    opencodeSessionId: string,
    status: OpencodeSessionStatus,
    client: OpencodeClient,
    dirOpts: ReturnType<typeof directoryOpts>,
  ): Promise<void> {
    this.surfaceStatusError(opencodeSessionId, status)
    this.queuedFollowUps.delete(opencodeSessionId)
    try {
      await client.session.abort({
        path: { id: opencodeSessionId },
        ...dirOpts,
        throwOnError: true,
      })
    } catch (err) {
      logger.warn({ err, opencodeSessionId }, 'failed to abort retrying opencode session')
    }
  }

  private surfaceStatusError(opencodeSessionId: string, status: OpencodeSessionStatus): void {
    const message = String(status.message ?? status.error ?? 'The agent hit an error and is retrying.')
    if (this.surfacedStatusErrors.get(opencodeSessionId) === message) return
    this.surfacedStatusErrors.set(opencodeSessionId, message)
    this.runningOpencodeSessions.delete(opencodeSessionId)
    this.emitTranscriptEvent(opencodeSessionId, 'session.error', {
      sessionID: opencodeSessionId,
      message,
      time: { created: Date.now() },
    })
    void this.createBlockingNotification(opencodeSessionId, 'error', 'error', 'Agent error', message)
  }

  private async sendPromptToOpencode(input: {
    row: { id: string; opencodeSessionId: string; title: string | null; workingDir: string | null; workspaceId: string | null; kind: AgentSessionKind }
    client: OpencodeClient
    model: { providerID: string; modelID: string }
    variant: ReasoningEffortVariant | null
    dirOpts: ReturnType<typeof directoryOpts>
    message: string
  }): Promise<void> {
    this.emitTranscriptEvent(input.row.opencodeSessionId, 'session.busy', { sessionID: input.row.opencodeSessionId })
    await input.client.session.promptAsync({
      path: { id: input.row.opencodeSessionId },
      body: promptBody({
        text: input.message,
        model: input.model,
        variant: input.variant,
        sessionKind: input.row.kind,
        workspaceScoped: Boolean(input.row.workspaceId),
      }),
      ...input.dirOpts,
      throwOnError: true,
    })
  }

  private async isOpencodeSessionRunning(client: OpencodeClient, opencodeSessionId: string, dirOpts: ReturnType<typeof directoryOpts>): Promise<boolean> {
    if (this.runningOpencodeSessions.has(opencodeSessionId)) return true
    try {
      const statusRes = await client.session.status({ ...dirOpts, throwOnError: true })
      const statuses = statusRes.data as Record<string, OpencodeSessionStatus>
      const st = statuses[opencodeSessionId]
      if (st?.type === 'retry') {
        await this.handleRetryStatus(opencodeSessionId, st, client, dirOpts)
        return false
      }
      return st?.type === 'busy'
    } catch {
      return false
    }
  }

  private async drainQueuedFollowUps(opencodeSessionId: string): Promise<void> {
    const queue = this.queuedFollowUps.get(opencodeSessionId)
    const next = queue?.shift()
    if (!next) return
    if (!queue) return
    if (queue.length === 0) this.queuedFollowUps.delete(opencodeSessionId)
    try {
      const row = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.opencodeSessionId, opencodeSessionId))
        .limit(1)
        .all()[0]
      if (!row) return
      const client = await this.getClient()
      const selection = await this.getSessionModel(row.id)
      const model = selection?.providerID && selection.modelID
        ? { providerID: selection.providerID, modelID: selection.modelID }
        : this.getDefaultModel()
      await this.sendPromptToOpencode({
        row,
        client,
        model,
        variant: selection?.variant ?? null,
        dirOpts: directoryOpts(row.workingDir),
        message: next.text,
      })
      db.update(agentSessions)
        .set({ lastActivityAt: new Date().toISOString() })
        .where(eq(agentSessions.id, row.id))
        .run()
    } catch (err) {
      queue?.unshift(next)
      if (queue && queue.length > 0) this.queuedFollowUps.set(opencodeSessionId, queue)
      logger.warn({ err, opencodeSessionId }, 'failed to send queued follow-up')
    }
  }

  private recordReplayEvent(opencodeSessionId: string, evt: TranscriptEvent): TranscriptEvent {
    if (!DURABLE_TRANSCRIPT_EVENT_TYPES.has(evt.type)) return evt

    const rootOpencodeSessionId = this.parentByChild.get(opencodeSessionId) ?? opencodeSessionId
    const rows = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.opencodeSessionId, rootOpencodeSessionId))
      .limit(1)
      .all()
    const row = rows[0]
    if (!row) return evt
    // seqCounters is in-memory and resets on restart; seed from the DB max
    // on first use of a session this process to avoid colliding with rows
    // written by a previous run.
    let prevSeq = this.seqCounters.get(row.id)
    if (prevSeq === undefined) {
      const max = db
        .select({ seq: agentTranscripts.seq })
        .from(agentTranscripts)
        .where(eq(agentTranscripts.sessionId, row.id))
        .orderBy(desc(agentTranscripts.seq))
        .limit(1)
        .all()[0]
      prevSeq = max?.seq ?? 0
    }
    const nextSeq = prevSeq + 1
    this.seqCounters.set(row.id, nextSeq)
    const replayEvent: TranscriptEvent = {
      ...evt,
      parentSessionId: evt.parentSessionId ?? this.parentByChild.get(evt.sessionId),
      seq: nextSeq,
    }
    try {
      db.insert(agentTranscripts)
        .values({
          sessionId: row.id,
          seq: nextSeq,
          role: evt.type,
          contentJson: JSON.stringify(replayEvent),
          createdAt: new Date().toISOString(),
        })
        .run()
      db.update(agentSessions)
        .set({ lastActivityAt: new Date().toISOString() })
        .where(eq(agentSessions.id, row.id))
        .run()
    } catch (err) {
      logger.warn({ err, id: row.id }, 'transcript insert failed')
    }
    return replayEvent
  }

  private transcriptReplayRows(sessionId: string, sinceSeq: number): TranscriptEvent[] {
    const rows = db
      .select()
      .from(agentTranscripts)
      .where(eq(agentTranscripts.sessionId, sessionId))
      .orderBy(asc(agentTranscripts.seq))
      .all()
    const out: TranscriptEvent[] = []
    for (const row of rows) {
      if (row.seq <= sinceSeq) continue
      const parsed = parseReplayEvent(row.contentJson, row.seq)
      if (parsed) out.push(parsed)
    }
    return out
  }

  private async createFinishedNotification(opencodeSessionId: string): Promise<void> {
    try {
      const row = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.opencodeSessionId, opencodeSessionId))
        .limit(1)
        .all()[0]
      if (!row) return
      if (!row.workspaceId) return
      const responseText = await this.lastAgentResponseText(row)
      const fallback = responseText || 'Chat finished'
      const summary = await this.summarizeNotification(responseText, fallback)
      await createAgentNotification({
        workspaceId: row.workspaceId,
        sessionId: row.id,
        kind: 'finished',
        title: row.title || 'Chat finished',
        summary,
      })
    } catch (err) {
      logger.warn({ err, opencodeSessionId }, 'failed to create agent notification')
    }
  }

  private isSubtaskOpencodeSession(opencodeSessionId: string): boolean {
    return db.select({ kind: agentSessions.kind }).from(agentSessions)
      .where(eq(agentSessions.opencodeSessionId, opencodeSessionId)).limit(1).all()[0]?.kind === 'subtask'
  }

  private async createBlockingNotification(opencodeSessionId: string, key: string, kind: 'question' | 'permission' | 'error', fallbackTitle: string, summary: string): Promise<void> {
    const notificationKey = `${opencodeSessionId}:${key}`
    if (this.blockingNotificationKeys.has(notificationKey)) return
    this.blockingNotificationKeys.add(notificationKey)
    try {
      const row = db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.opencodeSessionId, opencodeSessionId))
        .limit(1)
        .all()[0]
      if (!row?.workspaceId) return
      await createAgentNotification({
        workspaceId: row.workspaceId,
        sessionId: row.id,
        kind,
        title: row.title || fallbackTitle,
        summary: truncateNotificationSummary(summary),
      })
    } catch (err) {
      this.blockingNotificationKeys.delete(notificationKey)
      logger.warn({ err, opencodeSessionId, key }, 'failed to create blocking agent notification')
    }
  }

  private async lastAgentResponseText(row: { id: string; opencodeSessionId: string; workingDir: string | null }): Promise<string> {
    try {
      const client = await this.getClient()
      const res = await client.session.messages({
        path: { id: row.opencodeSessionId },
        ...directoryQueryOpts(row.workingDir, { limit: RECENT_MESSAGE_CONTEXT_LIMIT }),
        throwOnError: true,
      })
      const msgs = (res.data ?? []) as Array<{
        info?: { role?: string }
        parts?: Array<{ type?: string; text?: string }>
      }>
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const msg = msgs[i]
        if (msg?.info?.role !== 'assistant') continue
        const text = (msg.parts ?? [])
          .filter((part) => part.type === 'text' && part.text)
          .map((part) => part.text)
          .join('\n')
          .replace(/\s+/g, ' ')
          .trim()
        if (text) return text.slice(-8_000)
      }
    } catch {
      // Fall back to replay rows below; opencode may already be restarting.
    }
    return this.lastTranscriptText(row.id)
  }

  private lastTranscriptText(sessionId: string): string {
    const assistantMessageIds = new Set<string>()
    let last = ''
    for (const evt of this.transcriptReplayRows(sessionId, 0)) {
      if (evt.parentSessionId) continue
      if (evt.type === 'message.updated') {
        const info = (evt.payload as { info?: { id?: string; role?: string } }).info
        if (info?.role === 'assistant' && info.id) assistantMessageIds.add(info.id)
      }
      if (evt.type === 'message.part.updated') {
        const part = (evt.payload as { part?: { type?: string; text?: string; messageID?: string } }).part
        if (part?.type === 'text' && part.text && (!part.messageID || assistantMessageIds.has(part.messageID))) last = part.text
      }
    }
    return last.replace(/\s+/g, ' ').trim().slice(-8_000)
  }

  private async summarizeNotification(text: string, fallback: string): Promise<string> {
    const fallbackSummary = text ? briefResponseSummary(text) : truncateNotificationSummary(fallback)
    return fallbackSummary
  }

  private async requireSession(id: string) {
    const rows = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1)
      .all()
    const row = rows[0]
    if (!row) throw new AgentError('not_found', `agent session ${id} not found`)
    return row
  }

  private upsertAgentRuntimeForOpencode(opencodeSessionId: string, patch: { running?: boolean; lastActivityAt?: Date } = {}): void {
    const row = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.opencodeSessionId, opencodeSessionId))
      .limit(1)
      .all()[0]
    if (row) this.upsertAgentRuntime(row, patch)
  }

  private upsertAgentRuntime(row: {
    id: string
    workspaceId: string | null
    opencodeSessionId: string
    status: AgentSessionStatus
    lastActivityAt: string
  }, patch: { running?: boolean; lastActivityAt?: Date } = {}): void {
    if (row.status === 'archived') {
      getAgentRuntimeRealtime().delete(AGENT_SESSION_RUNTIME_TABLE, row.id)
      return
    }
    const realtime = getAgentRuntimeRealtime()
    const existing = realtime
      .snapshot(AGENT_SESSION_RUNTIME_TABLE)
      .rows
      .find((candidate) => candidate.sessionId === row.id) as { running?: boolean; lastActivityAt?: string } | undefined
    const now = new Date()
    const lastActivityAt = patch.lastActivityAt?.toISOString() ?? existing?.lastActivityAt ?? row.lastActivityAt
    realtime.upsert(AGENT_SESSION_RUNTIME_TABLE, {
      sessionId: row.id,
      workspaceId: row.workspaceId ?? null,
      running: patch.running ?? existing?.running ?? false,
      pendingAttentionCount: this.pendingAttentionCount(row.opencodeSessionId),
      lastActivityAt,
      updatedAt: now.toISOString(),
    })
  }

  private pendingAttentionCount(opencodeSessionId: string): number {
    return this.relatedOpencodeSessionIds(opencodeSessionId).reduce(
      (count, id) => count + (this.pending.get(id)?.size ?? 0) + (this.pendingQuestions.get(id)?.size ?? 0),
      0,
    )
  }

  private relatedOpencodeSessionIds(rootOpencodeSessionId: string): string[] {
    const root = this.resolveRootOpencodeSessionId(rootOpencodeSessionId)
    const out: string[] = []
    const seen = new Set<string>()
    const queue = [root]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
      for (const child of this.childrenByParent.get(id) ?? []) queue.push(child)
    }
    return out
  }

  private findPermissionSession(rootOpencodeSessionId: string, permissionId: string): string | null {
    for (const id of this.relatedOpencodeSessionIds(rootOpencodeSessionId)) {
      if (this.pending.get(id)?.has(permissionId)) return id
    }
    return null
  }

  private clearPermissionRequest(
    rootOpencodeSessionId: string,
    opencodeSessionId: string,
    permissionId: string,
  ): void {
    this.pending.get(opencodeSessionId)?.delete(permissionId)
    this.blockingNotificationKeys.delete(`${this.resolveRootOpencodeSessionId(opencodeSessionId)}:permission:${opencodeSessionId}:${permissionId}`)
    this.emitTranscriptEvent(opencodeSessionId, 'permission.replied', {
      sessionID: opencodeSessionId,
      permissionID: permissionId,
    })
    for (const id of this.relatedOpencodeSessionIds(rootOpencodeSessionId)) {
      if (id !== opencodeSessionId) this.pending.get(id)?.delete(permissionId)
    }
  }

  private deletePendingQuestion(rootOpencodeSessionId: string, requestId: string): void {
    for (const id of this.relatedOpencodeSessionIds(rootOpencodeSessionId)) {
      this.pendingQuestions.get(id)?.delete(requestId)
    }
  }

  private async sessionContext(sessionId: string) {
    const row = await this.requireSession(sessionId)
    const client = await this.getClient()
    const selection = await this.getSessionModel(row.id)
    const model = selection?.providerID && selection.modelID
      ? { providerID: selection.providerID, modelID: selection.modelID }
      : this.getDefaultModel()
    const variant = selection?.variant ?? null
    const dirOpts = directoryOpts(row.workingDir)
    const scopedFetch = (pth: string, init: RequestInit) =>
      this.opencodeFetch(pth, init, row.workingDir)
    return { row, client, model, variant, dirOpts, fetch: scopedFetch }
  }
}

function truncateNotificationSummary(value: string): string {
  const flat = value.replace(/\s+/g, ' ').replace(/^['"]|['"]$/g, '').trim()
  if (!flat) return 'Chat finished'
  return flat.length <= 80 ? flat : `${flat.slice(0, 77).replace(/[\s.,;:!?-]+$/, '')}...`
}

function briefResponseSummary(value: string): string {
  const flat = value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[\s*-]+/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/^['"]|['"]$/g, '')
    .trim()
  if (!flat) return 'Chat finished'
  const sentence = flat.match(/^.{12,}?[.!?](?=\s|$)/)?.[0] ?? flat
  return truncateNotificationSummary(sentence)
}

export const agentService = new AgentService()
