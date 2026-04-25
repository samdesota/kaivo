import { eq, desc } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { db } from '../db/client.js'
import { agentSessions, agentTranscripts, type AgentSessionStatus } from '../db/schema.js'
import { logger } from '../logger.js'
import { getMeta, setDefaultModel as setEnvDefaultModel } from '../envmeta/service.js'
import {
  OpenCodeError,
  opencodeBasicAuthHeader,
  opencodeSupervisor,
} from './opencode.js'

const BUILTIN_DEFAULT_MODEL = { providerID: 'openai', modelID: 'gpt-5.5' } as const

const CLOUD_TOOL_OVERRIDES = {
  bash: false,
  pty: false,
  cloud_bash: true,
  cloud_pty: true,
  cloud_pty_write: true,
  cloud_pty_read: true,
  cloud_pty_close: true,
  cloud_open_pane: true,
} as const

function directoryOpts(dir: string | null | undefined) {
  if (!dir) return {}
  return {
    query: { directory: dir },
    headers: { 'x-opencode-directory': dir },
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
      | 'unavailable'
      | 'start_failed',
    message: string,
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

export interface AgentSessionSummary {
  id: string
  opencodeSessionId: string
  title: string | null
  status: AgentSessionStatus
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

export interface TranscriptEvent {
  type:
    | 'message.updated'
    | 'message.part.updated'
    | 'permission.updated'
    | 'permission.replied'
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

class AgentService {
  private client: OpencodeClient | null = null
  private listeners = new Set<TranscriptListener>()
  private subs = new Map<string, SubState>()
  private pending = new Map<string, Map<string, PendingApproval>>() // opencodeSessionId -> permissionId
  private pendingQuestions = new Map<string, Map<string, PendingQuestion>>() // opencodeSessionId -> requestId
  private seqCounters = new Map<string, number>() // our session id -> next seq
  private parentByChild = new Map<string, string>()
  private childrenByParent = new Map<string, string[]>()
  private sessionModels = new Map<string, { providerID: string; modelID: string }>()
  private contextLimitCache = new Map<string, number>()

  async agentStatus(): Promise<{ ready: boolean; hasProvider: boolean }> {
    const ready = opencodeSupervisor.isReady()
    // `hasProvider` is now a derived property: opencode only runs if
    // identity has at least one provider configured.
    return { ready, hasProvider: ready }
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

  async sessionList(): Promise<AgentSessionSummary[]> {
    const rows = db
      .select()
      .from(agentSessions)
      .orderBy(desc(agentSessions.lastActivityAt))
      .all()
    return rows.map((r) => ({
      id: r.id,
      opencodeSessionId: r.opencodeSessionId,
      title: r.title,
      status: r.status,
      workingDir: r.workingDir ?? null,
      createdAt: dbDate(r.createdAt),
      lastActivityAt: dbDate(r.lastActivityAt),
    }))
  }

  async sessionStart(input: {
    prompt?: string
    title?: string
    directory?: string
    model?: { providerID: string; modelID: string }
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
    db.insert(agentSessions)
      .values({
        id,
        opencodeSessionId: ocSession.id,
        title: derivedTitle,
        status: 'active',
        workingDir: input.directory ?? null,
        selectedProviderId: input.model?.providerID ?? null,
        selectedModelId: input.model?.modelID ?? null,
        createdAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
      })
      .run()

    if (input.model) this.sessionModels.set(id, input.model)

    if (input.prompt) {
      const prompt = input.prompt
      void client.session
        .promptAsync({
          path: { id: ocSession.id },
          body: {
            parts: [{ type: 'text', text: prompt }],
            tools: CLOUD_TOOL_OVERRIDES,
            model,
          },
          ...directoryOpts(input.directory),
        })
        .catch((err) => logger.warn({ err, id }, 'session prompt failed'))
    }

    this.ensureSubscription(input.directory ?? '')

    return {
      id,
      opencodeSessionId: ocSession.id,
      title: derivedTitle,
      status: 'active',
      workingDir: input.directory ?? null,
      createdAt: now,
      lastActivityAt: now,
    }
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
    return {
      id: row.id,
      opencodeSessionId: row.opencodeSessionId,
      title,
      status: row.status,
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
    if (model) this.sessionModels.set(sessionId, model)
    else this.sessionModels.delete(sessionId)
    db.update(agentSessions)
      .set({
        selectedProviderId: model?.providerID ?? null,
        selectedModelId: model?.modelID ?? null,
      })
      .where(eq(agentSessions.id, sessionId))
      .run()
  }

  async getSessionModel(
    sessionId: string,
  ): Promise<{ providerID: string; modelID: string } | null> {
    const cached = this.sessionModels.get(sessionId)
    if (cached) return cached
    const rows = db
      .select({
        providerID: agentSessions.selectedProviderId,
        modelID: agentSessions.selectedModelId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1)
      .all()
    const r = rows[0]
    if (!r || !r.providerID || !r.modelID) return null
    const hydrated = { providerID: r.providerID, modelID: r.modelID }
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
    if (cached !== undefined) return cached
    try {
      const res = await client.config.providers({ throwOnError: true })
      const body = res.data as {
        providers: Array<{
          id: string
          models: Record<string, { id: string; limit?: { context?: number } }>
        }>
      }
      for (const p of body.providers) {
        for (const m of Object.values(p.models ?? {})) {
          const k = `${p.id}/${m.id}`
          if (m.limit?.context) this.contextLimitCache.set(k, m.limit.context)
        }
      }
      return this.contextLimitCache.get(key) ?? null
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
    const { row, client, model, dirOpts } = await this.sessionContext(input.sessionId)
    await client.session.command({
      path: { id: row.opencodeSessionId },
      body: {
        command: input.command,
        arguments: input.arguments,
        model: `${model.providerID}/${model.modelID}`,
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
    return {
      id: row.id,
      opencodeSessionId: row.opencodeSessionId,
      title: row.title,
      status: input.status,
      workingDir: row.workingDir ?? null,
      createdAt: dbDate(row.createdAt),
      lastActivityAt: now,
    }
  }

  async sessionSend(input: { sessionId: string; message: string }): Promise<void> {
    const { row, client, model, dirOpts } = await this.sessionContext(input.sessionId)
    await client.session.promptAsync({
      path: { id: row.opencodeSessionId },
      body: {
        parts: [{ type: 'text', text: input.message }],
        tools: CLOUD_TOOL_OVERRIDES,
        model,
      },
      ...dirOpts,
      throwOnError: true,
    })
    const nextTitle =
      !row.title || /^New session - /.test(row.title) ? truncatePromptForTitle(input.message) : row.title
    db.update(agentSessions)
      .set({
        title: nextTitle,
        lastActivityAt: new Date().toISOString(),
      })
      .where(eq(agentSessions.id, row.id))
      .run()
  }

  async sessionMessages(
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
  }> {
    const { row, client, dirOpts } = await this.sessionContext(input.sessionId)
    const pendingMap = this.pending.get(row.opencodeSessionId)
    const pending = pendingMap ? [...pendingMap.values()] : []
    const questionMap = this.pendingQuestions.get(row.opencodeSessionId)
    let questions = questionMap ? [...questionMap.values()] : []
    if (questions.length === 0) {
      try {
        const fresh = await this.questionList()
        questions = fresh.filter((q) => q.sessionId === row.opencodeSessionId)
        if (questions.length > 0) {
          let byReq = this.pendingQuestions.get(row.opencodeSessionId)
          if (!byReq) {
            byReq = new Map()
            this.pendingQuestions.set(row.opencodeSessionId, byReq)
          }
          for (const q of questions) byReq.set(q.id, q)
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
      const statuses = statusRes.data as Record<string, { type: string }>
      const st = statuses[row.opencodeSessionId]
      running = st?.type === 'busy'
    } catch {
      // opencode down
    }
    let contextUsage: { used: number; limit: number } | null = null
    try {
      const msgRes = await client.session.messages({
        path: { id: row.opencodeSessionId },
        ...dirOpts,
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
        opencodeSessionId: row.opencodeSessionId,
        title: row.title,
        status: row.status,
        workingDir: row.workingDir ?? null,
        createdAt: dbDate(row.createdAt),
        lastActivityAt: dbDate(row.lastActivityAt),
      },
      pendingApprovals: pending,
      pendingQuestions: questions,
      todos,
      running,
      contextUsage,
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
    this.pendingQuestions.get(ctx.row.opencodeSessionId)?.delete(input.requestId)
  }

  async sessionRejectQuestion(input: {
    sessionId: string
    requestId: string
  }): Promise<void> {
    const ctx = await this.sessionContext(input.sessionId)
    await ctx.fetch(`/question/${encodeURIComponent(input.requestId)}/reject`, {
      method: 'POST',
    })
    this.pendingQuestions.get(ctx.row.opencodeSessionId)?.delete(input.requestId)
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
    await client.session.abort({
      path: { id: row.opencodeSessionId },
      ...dirOpts,
      throwOnError: true,
    })
  }

  async sessionRespond(input: {
    sessionId: string
    permissionId: string
    response: 'once' | 'always' | 'reject'
  }): Promise<void> {
    const { row, client, dirOpts } = await this.sessionContext(input.sessionId)
    await client.postSessionIdPermissionsPermissionId({
      path: { id: row.opencodeSessionId, permissionID: input.permissionId },
      body: { response: input.response },
      ...dirOpts,
      throwOnError: true,
    })
    this.pending.get(row.opencodeSessionId)?.delete(input.permissionId)
  }

  subscribeTranscript(sessionId: string, fn: TranscriptListener): () => void {
    let unsubscribed = false
    let innerUnsub: (() => void) | null = null
    void (async () => {
      const row = await this.requireSession(sessionId).catch(() => null)
      if (!row || unsubscribed) return
      const directory = row.workingDir ?? ''
      const state = this.getOrCreateSubState(directory)
      state.listenerCount++
      this.ensureSubscription(directory)
      const wrapper: TranscriptListener = (evt) => {
        if (evt.sessionId === row.opencodeSessionId) {
          fn(evt)
          return
        }
        if (this.parentByChild.get(evt.sessionId) === row.opencodeSessionId) {
          fn({ ...evt, parentSessionId: row.opencodeSessionId })
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
      if (unsubscribed) innerUnsub()
    })()
    return () => {
      unsubscribed = true
      innerUnsub?.()
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
      for await (const evt of stream.stream) {
        if (controller.signal.aborted) break
        await this.handleEvent(evt)
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
          const fanout: TranscriptEvent = {
            type: 'child.session.created',
            sessionId: childId,
            parentSessionId: parentId,
            payload: { info: info as Record<string, unknown> },
          }
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
      byPerm.set(p.id, {
        id: p.id,
        sessionId: p.sessionID,
        callID: p.callID ?? (p.metadata as { callID?: string } | undefined)?.callID,
        title: p.title ?? 'Approval required',
        pattern: p.pattern,
        metadata: p.metadata ?? {},
        createdAt: p.time?.created ?? Date.now(),
      })
    } else if (type === 'permission.replied') {
      const p = props as { permissionID?: string }
      if (p.permissionID) this.pending.get(ocSessionId)?.delete(p.permissionID)
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
      }
    } else if (type === 'question.replied' || type === 'question.rejected') {
      const q = props as { requestID?: string }
      if (q.requestID) this.pendingQuestions.get(ocSessionId)?.delete(q.requestID)
    }

    if (type === 'message.updated') {
      await this.recordTranscript(ocSessionId, props)
    }

    const evt: TranscriptEvent = {
      type: type as TranscriptEvent['type'],
      sessionId: ocSessionId,
      payload: props,
    }
    for (const l of this.listeners) {
      try {
        l(evt)
      } catch (err) {
        logger.warn({ err }, 'transcript listener threw')
      }
    }
  }

  private async recordTranscript(
    opencodeSessionId: string,
    props: Record<string, unknown>,
  ): Promise<void> {
    const info = (props as { info?: { id?: string; role?: string } }).info
    if (!info?.id || !info.role) return
    const rows = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.opencodeSessionId, opencodeSessionId))
      .limit(1)
      .all()
    const row = rows[0]
    if (!row) return
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
    try {
      db.insert(agentTranscripts)
        .values({
          sessionId: row.id,
          seq: nextSeq,
          role: info.role,
          contentJson: JSON.stringify(props),
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

  private async sessionContext(sessionId: string) {
    const row = await this.requireSession(sessionId)
    const client = await this.getClient()
    const model = (await this.getSessionModel(row.id)) ?? this.getDefaultModel()
    const dirOpts = directoryOpts(row.workingDir)
    const scopedFetch = (pth: string, init: RequestInit) =>
      this.opencodeFetch(pth, init, row.workingDir)
    return { row, client, model, dirOpts, fetch: scopedFetch }
  }
}

export const agentService = new AgentService()
