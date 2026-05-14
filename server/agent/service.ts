import { eq, desc } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { db } from '../db/client.js'
import { agentSessions, agentTranscripts, type AgentSessionStatus } from '../db/schema.js'
import { logger } from '../logger.js'
import { sandboxManager } from '../sandbox/manager.js'
import { getSecret, putSecret } from '../secrets/index.js'
import { anyProviderConfigured } from './providers.js'
import {
  OpenCodeError,
  getOpenCodePassword,
  isOpenCodeReady,
  opencodeBasicAuthHeader,
  resolveEndpoint,
  startOpenCode,
} from './opencode.js'

const BUILTIN_DEFAULT_MODEL = { providerID: 'openai', modelID: 'gpt-5.5' } as const
const DEFAULT_MODEL_SECRET = 'agent.default_model'

/**
 * Force every prompt to route shell work through our plugin tools so the
 * shells show up in the Shells panel and share scrollback with the human.
 * Leaving OpenCode's builtin bash/pty enabled means the model will happily
 * pick `bash` and silently open a one-shot shell the UI can't attach to.
 */
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
} as const

/** Turn a user prompt into a compact session title (≤60 chars, single line). */
function truncatePromptForTitle(msg: string): string {
  const flat = msg.replace(/\s+/g, ' ').trim()
  if (flat.length <= 60) return flat
  return flat.slice(0, 57).replace(/[\s.,;:!?-]+$/, '') + '…'
}

export class AgentError extends Error {
  constructor(
    public code:
      | 'sandbox_unavailable'
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
  sandboxId: string
  opencodeSessionId: string
  title: string | null
  status: AgentSessionStatus
  createdAt: Date
  lastActivityAt: Date
}

export interface PendingApproval {
  id: string
  sessionId: string
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
  /** OpenCode session ID the event came from (parent or child). */
  sessionId: string
  /**
   * Set when this event came from a child of the subscribed-to parent. UI
   * uses this to route events to the child sub-transcript instead of the
   * parent's main one.
   */
  parentSessionId?: string
  // Forward OpenCode event payload verbatim; UI can render deltas.
  payload: Record<string, unknown>
}

type TranscriptListener = (evt: TranscriptEvent) => void

interface SandboxSubscription {
  listeners: Set<TranscriptListener>
  controller: AbortController | null
  running: boolean
  restartTimer: ReturnType<typeof setTimeout> | null
}

export interface ModelInfo {
  providerID: string
  modelID: string
  label: string
}

class AgentService {
  private clients = new Map<string, OpencodeClient>()
  private subs = new Map<string, SandboxSubscription>()
  private pending = new Map<string, Map<string, PendingApproval>>() // opencodeSessionId -> permissionId -> req
  private pendingQuestions = new Map<string, Map<string, PendingQuestion>>() // opencodeSessionId -> requestId -> question
  private seqCounters = new Map<string, number>() // sessionId (ours) -> next seq
  /**
   * Reverse-index: child opencode sessionID → parent opencode sessionID.
   * Populated from `session.created` / `session.updated` events whose
   * `info.parentID` is set. Lets us forward child-session events to a
   * parent's transcript subscriber so the UI can stream subagent output.
   */
  private parentByChild = new Map<string, string>()
  /** Parent oc id → ordered list of child oc ids (insertion order). */
  private childrenByParent = new Map<string, string[]>()
  /**
   * Per-session model override. Kept in memory — on server restart, sessions
   * fall back to OpenCode's default model until the user picks again. Good
   * enough for v1; promote to a DB column if users complain.
   */
  private sessionModels = new Map<string, { providerID: string; modelID: string }>()
  private wired = false

  /**
   * Subscribe to sandbox lifecycle events so `opencode serve` gets started
   * (or re-started) whenever a sandbox enters an active+running state. Call
   * once at app boot.
   */
  wireSandboxLifecycle(): void {
    if (this.wired) return
    this.wired = true
    sandboxManager.onEvent((evt) => {
      if (evt.type === 'created' || evt.type === 'status_changed') {
        if (evt.status === 'active' || evt.type === 'created') {
          void this.ensureBootstrapped(evt.sandboxId)
        }
      }
      if (evt.type === 'archived' || evt.type === 'deleted') {
        this.clients.delete(evt.sandboxId)
        this.stopSubscription(evt.sandboxId)
      }
    })
  }

  /**
   * Start `opencode serve` for every active sandbox on app boot. Runs after
   * the sandbox reconciler so containers exist. Errors are logged but do not
   * abort — operators can still reach sandboxes without the agent.
   */
  async reconcile(): Promise<void> {
    const list = await sandboxManager.list()
    for (const sb of list) {
      if (sb.status !== 'active' || !sb.running) continue
      await this.ensureBootstrapped(sb.id)
    }
  }

  /** Call from `SandboxManager` create + reconciler. Idempotent. */
  async ensureBootstrapped(sandboxId: string): Promise<void> {
    try {
      const cfg = await anyProviderConfigured()
      if (!cfg) {
        logger.info({ sandboxId }, 'no provider configured; skipping opencode bootstrap')
        return
      }
      const sb = await sandboxManager.get(sandboxId)
      if (!sb || !sb.running) return
      await startOpenCode(sandboxId)
    } catch (err) {
      logger.warn({ err, sandboxId }, 'opencode bootstrap failed')
    }
  }

  async agentStatus(sandboxId: string): Promise<{
    ready: boolean
    hasProvider: boolean
  }> {
    const hasProvider = await anyProviderConfigured()
    const ready = await isOpenCodeReady(sandboxId)
    return { ready, hasProvider }
  }

  /** Explicit user-triggered boot for older sandboxes. Propagates errors. */
  async startAgent(sandboxId: string): Promise<void> {
    const cfg = await anyProviderConfigured()
    if (!cfg) throw new AgentError('no_provider', 'no provider API key configured')
    try {
      await startOpenCode(sandboxId)
    } catch (err) {
      if (err instanceof OpenCodeError) {
        throw new AgentError(
          err.code === 'sandbox_unavailable' ? 'sandbox_unavailable' : 'start_failed',
          err.message,
        )
      }
      throw err
    }
  }

  private async getClient(sandboxId: string): Promise<OpencodeClient> {
    const cached = this.clients.get(sandboxId)
    const ep = await resolveEndpoint(sandboxId)
    if (!ep) throw new AgentError('sandbox_unavailable', 'sandbox is not running')
    if (!(await isOpenCodeReady(sandboxId))) {
      // Try a lazy restart, once.
      await this.startAgent(sandboxId)
    }
    if (cached) return cached
    const client = createOpencodeClient({
      baseUrl: `http://${ep.ip}:${ep.port}`,
      // OpenCode's server enforces Basic auth with username=opencode when
      // OPENCODE_SERVER_PASSWORD is set; Bearer was rejected with 401.
      headers: { Authorization: opencodeBasicAuthHeader(ep.password) },
    })
    this.clients.set(sandboxId, client)
    return client
  }

  private invalidateClient(sandboxId: string): void {
    this.clients.delete(sandboxId)
  }

  async sessionList(sandboxId: string): Promise<AgentSessionSummary[]> {
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sandboxId, sandboxId))
      .orderBy(desc(agentSessions.lastActivityAt))
    return rows.map((r) => ({
      id: r.id,
      sandboxId: r.sandboxId,
      opencodeSessionId: r.opencodeSessionId,
      title: r.title,
      status: r.status,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
    }))
  }

  async sessionStart(input: {
    sandboxId: string
    prompt?: string
    title?: string
    directory?: string
    model?: { providerID: string; modelID: string }
  }): Promise<AgentSessionSummary> {
    const client = await this.getClient(input.sandboxId)
    const model = input.model ?? await this.getDefaultModel()
    // Intentionally do NOT pass `directory` on session.create — OpenCode
    // routes events through a per-project bus when a session is bound to a
    // non-default directory, and our global /event subscription stops
    // receiving message.part.updated / permission.asked events for it. We
    // instead inject the target directory into the first prompt so the agent
    // starts work there without splitting the event stream.
    const create = await client.session.create({
      body: { title: input.title },
      throwOnError: true,
    })
    const ocSession = create.data
    const id = ulid().toLowerCase()
    const now = new Date()
    // If the caller provided an initial prompt but no explicit title, seed the
    // title from a truncated prompt so the session tab is meaningful right
    // away. OpenCode's default "New session - <timestamp>" is used only when
    // we have nothing better.
    const derivedTitle =
      input.title ??
      (input.prompt ? truncatePromptForTitle(input.prompt) : undefined) ??
      ocSession.title ??
      null
    const resolvedTitle = derivedTitle
    await db.insert(agentSessions).values({
      id,
      sandboxId: input.sandboxId,
      opencodeSessionId: ocSession.id,
      title: resolvedTitle,
      status: 'active',
      selectedProviderId: input.model?.providerID ?? null,
      selectedModelId: input.model?.modelID ?? null,
      createdAt: now,
      lastActivityAt: now,
    })

    // Remember the caller-provided model so every subsequent send picks the
    // same one without the UI having to thread it through each time.
    if (input.model) this.sessionModels.set(id, input.model)

    // Fire the initial prompt asynchronously if provided. The `directory`
    // input is recorded for future cwd-aware features but NOT injected as a
    // prompt — the agent figures out which repo from the user's own message.
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
        })
        .catch((err) => logger.warn({ err, id }, 'session prompt failed'))
    }

    this.ensureSubscription(input.sandboxId)

    return {
      id,
      sandboxId: input.sandboxId,
      opencodeSessionId: ocSession.id,
      title: resolvedTitle,
      status: 'active',
      createdAt: now,
      lastActivityAt: now,
    }
  }

  /** Rename a session (used by the `/rename` slash command). */
  async sessionRename(input: { sessionId: string; title: string }): Promise<AgentSessionSummary> {
    const row = await this.requireSession(input.sessionId)
    const title = input.title.trim().slice(0, 200)
    if (!title) throw new AgentError('not_found', 'title cannot be empty')
    const now = new Date()
    await db
      .update(agentSessions)
      .set({ title, lastActivityAt: now })
      .where(eq(agentSessions.id, row.id))
    return {
      id: row.id,
      sandboxId: row.sandboxId,
      opencodeSessionId: row.opencodeSessionId,
      title,
      status: row.status,
      createdAt: row.createdAt,
      lastActivityAt: now,
    }
  }

  /**
   * List model/provider pairs available inside this sandbox's opencode. UI
   * uses this for the per-session model picker.
   */
  async listModels(sandboxId: string): Promise<{
    models: ModelInfo[]
    defaultProviderID: string | null
    defaultModelID: string | null
  }> {
    const client = await this.getClient(sandboxId)
    const res = await client.config.providers({ throwOnError: true })
    const body = res.data as {
      providers: Array<{ id: string; name?: string; models: Record<string, { id: string; name?: string }> }>
      default: Record<string, string>
    }
    const models: ModelInfo[] = []
    for (const p of body.providers) {
      for (const m of Object.values(p.models ?? {})) {
        models.push({
          providerID: p.id,
          modelID: m.id,
          label: `${p.id}/${m.id}`,
        })
      }
    }
    models.sort((a, b) => a.label.localeCompare(b.label))
    const defaultModel = await this.getDefaultModel()
    return {
      models,
      defaultProviderID: defaultModel.providerID,
      defaultModelID: defaultModel.modelID,
    }
  }

  async getDefaultModel(): Promise<{ providerID: string; modelID: string }> {
    const raw = await getSecret(DEFAULT_MODEL_SECRET)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { providerID?: unknown; modelID?: unknown }
        if (typeof parsed.providerID === 'string' && typeof parsed.modelID === 'string') {
          return { providerID: parsed.providerID, modelID: parsed.modelID }
        }
      } catch {
        // Fall through to the built-in default.
      }
    }
    return { ...BUILTIN_DEFAULT_MODEL }
  }

  async setDefaultModel(model: { providerID: string; modelID: string }): Promise<void> {
    await putSecret(DEFAULT_MODEL_SECRET, JSON.stringify(model))
  }

  async setSessionModel(
    sessionId: string,
    model: { providerID: string; modelID: string } | null,
  ): Promise<void> {
    if (model) this.sessionModels.set(sessionId, model)
    else this.sessionModels.delete(sessionId)
    await db
      .update(agentSessions)
      .set({
        selectedProviderId: model?.providerID ?? null,
        selectedModelId: model?.modelID ?? null,
      })
      .where(eq(agentSessions.id, sessionId))
  }

  async getSessionModel(
    sessionId: string,
  ): Promise<{ providerID: string; modelID: string } | null> {
    const cached = this.sessionModels.get(sessionId)
    if (cached) return cached
    const rows = await db
      .select({
        providerID: agentSessions.selectedProviderId,
        modelID: agentSessions.selectedModelId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1)
    const r = rows[0]
    if (!r || !r.providerID || !r.modelID) return null
    const hydrated = { providerID: r.providerID, modelID: r.modelID }
    this.sessionModels.set(sessionId, hydrated)
    return hydrated
  }

  /**
   * List OpenCode template commands available in this sandbox. Drives the
   * composer's slash-command autocomplete.
   */
  async listCommands(sandboxId: string): Promise<
    Array<{ name: string; description?: string; template?: string; agent?: string; model?: string }>
  > {
    const client = await this.getClient(sandboxId)
    const res = await client.command.list({ throwOnError: true })
    return (res.data ?? []) as Array<{
      name: string
      description?: string
      template?: string
      agent?: string
      model?: string
    }>
  }

  /** Execute an OpenCode template command inside a session. */
  async runCommand(input: {
    sessionId: string
    command: string
    arguments: string
  }): Promise<void> {
    const row = await this.requireSession(input.sessionId)
    const client = await this.getClient(row.sandboxId)
    this.ensureSubscription(row.sandboxId)
    await client.session.command({
      path: { id: row.opencodeSessionId },
      body: {
        command: input.command,
        arguments: input.arguments,
      },
      throwOnError: true,
    })
    await db
      .update(agentSessions)
      .set({ lastActivityAt: new Date() })
      .where(eq(agentSessions.id, row.id))
  }

  async sessionSetStatus(input: {
    sessionId: string
    status: 'active' | 'archived'
  }): Promise<AgentSessionSummary> {
    const row = await this.requireSession(input.sessionId)
    const now = new Date()
    await db
      .update(agentSessions)
      .set({ status: input.status, lastActivityAt: now })
      .where(eq(agentSessions.id, row.id))
    return {
      id: row.id,
      sandboxId: row.sandboxId,
      opencodeSessionId: row.opencodeSessionId,
      title: row.title,
      status: input.status,
      createdAt: row.createdAt,
      lastActivityAt: now,
    }
  }

  async sessionSend(input: { sessionId: string; message: string }): Promise<void> {
    const row = await this.requireSession(input.sessionId)
    const client = await this.getClient(row.sandboxId)
    const model = (await this.getSessionModel(row.id)) ?? await this.getDefaultModel()
    this.ensureSubscription(row.sandboxId)
    await client.session.promptAsync({
      path: { id: row.opencodeSessionId },
      body: {
        parts: [{ type: 'text', text: input.message }],
        tools: CLOUD_TOOL_OVERRIDES,
        model,
      },
      throwOnError: true,
    })
    // If this is the session's first real user turn (title is still null or
    // the placeholder OpenCode assigned), derive a short title from the
    // message. Makes the session tab meaningful without a modal.
    const next: { lastActivityAt: Date; title?: string } = { lastActivityAt: new Date() }
    if (!row.title || /^New session - /.test(row.title)) {
      next.title = truncatePromptForTitle(input.message)
    }
    await db.update(agentSessions).set(next).where(eq(agentSessions.id, row.id))
  }

  /**
   * Cold-load the full message history for a session. UI hydrates from this,
   * then switches to the live `transcript` subscription. Messages are returned
   * in OpenCode's canonical order (the SDK response is already sorted).
   */
  async sessionMessages(
    sessionId: string,
  ): Promise<
    Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  > {
    const row = await this.requireSession(sessionId)
    const client = await this.getClient(row.sandboxId)
    const res = await client.session.messages({
      path: { id: row.opencodeSessionId },
      throwOnError: true,
    })
    return (res.data ?? []) as Array<{
      info: Record<string, unknown>
      parts: Array<Record<string, unknown>>
    }>
  }

  /**
   * Cold-load all child (subagent) sessions for a parent, with each child's
   * full message history. UI calls this on session hydrate so completed task
   * tools can render their subagent transcript inline even after a reload.
   * Returned in opencode creation order (oldest first), matching the order
   * the parent's task tool calls were made.
   */
  async childTranscripts(sessionId: string): Promise<
    Array<{
      sessionID: string
      parentID: string
      title: string | null
      createdAt: number
      messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
    }>
  > {
    const row = await this.requireSession(sessionId)
    const client = await this.getClient(row.sandboxId)
    const all = await client.session.list({ throwOnError: true })
    const sessions = (all.data ?? []) as Array<{
      id: string
      parentID?: string
      title?: string
      time?: { created?: number }
    }>
    const children = sessions
      .filter((s) => s.parentID === row.opencodeSessionId)
      .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
    // Backfill the parent↔child index so live events from these sessions get
    // forwarded even if we missed the original session.created (e.g. server
    // restarted while the parent was idle).
    const list = this.childrenByParent.get(row.opencodeSessionId) ?? []
    for (const c of children) {
      if (!this.parentByChild.has(c.id)) this.parentByChild.set(c.id, row.opencodeSessionId)
      if (!list.includes(c.id)) list.push(c.id)
    }
    this.childrenByParent.set(row.opencodeSessionId, list)
    const out = await Promise.all(
      children.map(async (c) => {
        const res = await client.session
          .messages({ path: { id: c.id }, throwOnError: true })
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
    /** True when the most recent assistant message has not yet completed. */
    running: boolean
  }> {
    const row = await this.requireSession(input.sessionId)
    const pendingMap = this.pending.get(row.opencodeSessionId)
    const pending = pendingMap ? [...pendingMap.values()] : []
    const questionMap = this.pendingQuestions.get(row.opencodeSessionId)
    let questions = questionMap ? [...questionMap.values()] : []
    // Cold-load: ask opencode directly so a page reload sees questions even if
    // we never observed the original question.asked event (server restart, etc.)
    if (questions.length === 0) {
      try {
        const fresh = await this.questionList(row.sandboxId)
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
        // sandbox unreachable — leave empty.
      }
    }
    // Cold-load the session's current todo list. The reducer-driven `todos`
    // map in the UI converges to this on first poll then live-updates via
    // `todo.updated` events.
    let todos: TodoItem[] = []
    try {
      const client = await this.getClient(row.sandboxId)
      const res = await client.session.todo({
        path: { id: row.opencodeSessionId },
        throwOnError: true,
      })
      todos = ((res.data ?? []) as TodoItem[]).map((t) => ({
        id: t.id,
        content: t.content,
        status: t.status,
        priority: t.priority,
      }))
    } catch {
      // empty todos
    }
    let running = false
    try {
      const client = await this.getClient(row.sandboxId)
      const res = await client.session.messages({
        path: { id: row.opencodeSessionId },
        throwOnError: true,
      })
      const msgs = (res.data ?? []) as Array<{
        info?: { role?: string; time?: { completed?: number } }
      }>
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i]?.info
        if (info?.role === 'assistant') {
          running = !info.time?.completed
          break
        }
      }
    } catch {
      // sandbox / opencode not reachable — leave running=false rather than throw.
    }
    return {
      session: {
        id: row.id,
        sandboxId: row.sandboxId,
        opencodeSessionId: row.opencodeSessionId,
        title: row.title,
        status: row.status,
        createdAt: row.createdAt,
        lastActivityAt: row.lastActivityAt,
      },
      pendingApprovals: pending,
      pendingQuestions: questions,
      todos,
      running,
    }
  }

  async sessionAnswerQuestion(input: {
    sessionId: string
    requestId: string
    answers: string[][]
  }): Promise<void> {
    const row = await this.requireSession(input.sessionId)
    await this.opencodeFetch(row.sandboxId, `/question/${encodeURIComponent(input.requestId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ answers: input.answers }),
    })
    this.pendingQuestions.get(row.opencodeSessionId)?.delete(input.requestId)
  }

  async sessionRejectQuestion(input: {
    sessionId: string
    requestId: string
  }): Promise<void> {
    const row = await this.requireSession(input.sessionId)
    await this.opencodeFetch(row.sandboxId, `/question/${encodeURIComponent(input.requestId)}/reject`, {
      method: 'POST',
    })
    this.pendingQuestions.get(row.opencodeSessionId)?.delete(input.requestId)
  }

  /** Fetch the current set of pending questions (opencode-wide, all sessions). */
  private async questionList(sandboxId: string): Promise<PendingQuestion[]> {
    const res = await this.opencodeFetch(sandboxId, '/question', { method: 'GET' })
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

  /** Raw fetch against this sandbox's opencode server. Caller handles JSON. */
  private async opencodeFetch(sandboxId: string, path: string, init: RequestInit): Promise<Response> {
    const ep = await resolveEndpoint(sandboxId)
    if (!ep) throw new AgentError('sandbox_unavailable', 'sandbox is not running')
    const headers = new Headers(init.headers)
    headers.set('Authorization', opencodeBasicAuthHeader(ep.password))
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const res = await fetch(`http://${ep.ip}:${ep.port}${path}`, { ...init, headers })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new AgentError('unavailable', `opencode ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 200)}`)
    }
    return res
  }

  async sessionAbort(input: { sessionId: string }): Promise<void> {
    const row = await this.requireSession(input.sessionId)
    const client = await this.getClient(row.sandboxId)
    await client.session.abort({
      path: { id: row.opencodeSessionId },
      throwOnError: true,
    })
  }

  async sessionRespond(input: {
    sessionId: string
    permissionId: string
    response: 'once' | 'always' | 'reject'
  }): Promise<void> {
    const row = await this.requireSession(input.sessionId)
    const client = await this.getClient(row.sandboxId)
    await client.postSessionIdPermissionsPermissionId({
      path: { id: row.opencodeSessionId, permissionID: input.permissionId },
      body: { response: input.response },
      throwOnError: true,
    })
    const pendingMap = this.pending.get(row.opencodeSessionId)
    pendingMap?.delete(input.permissionId)
  }

  /** Subscribe to forwarded OpenCode events for a specific session. */
  subscribeTranscript(sessionId: string, fn: TranscriptListener): () => void {
    let unsubscribed = false
    let innerUnsub: (() => void) | null = null
    void (async () => {
      const row = await this.requireSession(sessionId).catch(() => null)
      if (!row || unsubscribed) return
      this.ensureSubscription(row.sandboxId)
      const state = this.subs.get(row.sandboxId)!
      const wrapper: TranscriptListener = (evt) => {
        if (evt.sessionId === row.opencodeSessionId) {
          fn(evt)
          return
        }
        // Also forward events from any descendant sessions (subagents spawned
        // via the task tool). Annotate with parentSessionId so the UI can
        // route them into the matching child sub-transcript.
        if (this.parentByChild.get(evt.sessionId) === row.opencodeSessionId) {
          fn({ ...evt, parentSessionId: row.opencodeSessionId })
        }
      }
      state.listeners.add(wrapper)
      innerUnsub = () => {
        state.listeners.delete(wrapper)
        if (state.listeners.size === 0) this.stopSubscription(row.sandboxId)
      }
      if (unsubscribed) innerUnsub()
    })()
    return () => {
      unsubscribed = true
      innerUnsub?.()
    }
  }

  private ensureSubscription(sandboxId: string): void {
    let st = this.subs.get(sandboxId)
    if (!st) {
      st = { listeners: new Set(), controller: null, running: false, restartTimer: null }
      this.subs.set(sandboxId, st)
    }
    if (st.running) return
    st.running = true
    void this.runEventLoop(sandboxId).finally(() => {
      const s = this.subs.get(sandboxId)
      if (s) s.running = false
    })
  }

  private stopSubscription(sandboxId: string): void {
    const st = this.subs.get(sandboxId)
    if (!st) return
    if (st.controller) {
      try {
        st.controller.abort()
      } catch {
        /* ignore */
      }
    }
    if (st.restartTimer) {
      clearTimeout(st.restartTimer)
      st.restartTimer = null
    }
    this.subs.delete(sandboxId)
  }

  private async runEventLoop(sandboxId: string): Promise<void> {
    const st = this.subs.get(sandboxId)
    if (!st) return
    let client: OpencodeClient
    try {
      client = await this.getClient(sandboxId)
    } catch (err) {
      logger.warn({ err, sandboxId }, 'agent subscribe: client init failed')
      this.scheduleRestart(sandboxId)
      return
    }
    const controller = new AbortController()
    st.controller = controller
    try {
      // SDK returns an async iterable of SSE events.
      const stream = await client.event.subscribe({
        signal: controller.signal,
      })
      let endedCleanly = true
      for await (const evt of stream.stream) {
        if (controller.signal.aborted) {
          endedCleanly = false
          break
        }
        await this.handleEvent(sandboxId, evt)
      }
      if (endedCleanly && !controller.signal.aborted) {
        logger.warn({ sandboxId }, 'agent event stream ended')
        this.scheduleRestart(sandboxId)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        logger.warn({ err, sandboxId }, 'agent event stream failed')
        this.invalidateClient(sandboxId)
        this.scheduleRestart(sandboxId)
      }
    } finally {
      st.controller = null
    }
  }

  private scheduleRestart(sandboxId: string): void {
    const st = this.subs.get(sandboxId)
    if (!st || st.listeners.size === 0) return
    if (st.restartTimer) return
    st.restartTimer = setTimeout(() => {
      st.restartTimer = null
      if (st.listeners.size > 0) this.ensureSubscription(sandboxId)
    }, 2_000)
    st.restartTimer.unref?.()
  }

  private async handleEvent(sandboxId: string, raw: unknown): Promise<void> {
    const ev = raw as { type?: string; properties?: Record<string, unknown> }
    let type = ev?.type
    const props = ev?.properties ?? {}
    if (!type) return

    // OpenCode 1.4.14 publishes `permission.asked` for new requests; the
    // 1.4.17 SDK types call the same event `permission.updated`. Accept both
    // and normalize so downstream code only deals with `permission.updated`.
    if (type === 'permission.asked') type = 'permission.updated'

    // Normalize 1.4.14's Permission payload to the 1.4.17 shape the SDK +
    // frontend expect. OpenCode 1.4.14 nests `callID` under `tool`, names the
    // array `patterns` (not `pattern`), and omits `title` / `time.created`.
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

    // session.created / session.updated: maintain parent↔child index, and if
    // this is a NEW child of some known parent, fan out a synthetic
    // `child.session.created` so subscribers learn about it in order.
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
          // Notify parent's listeners that a new child has appeared. UI uses
          // this (in arrival order) to match the Nth task tool call to the
          // Nth child session.
          const st = this.subs.get(sandboxId)
          if (st) {
            const fanout: TranscriptEvent = {
              type: 'child.session.created',
              sessionId: childId,
              parentSessionId: parentId,
              payload: { info: info as Record<string, unknown> },
            }
            for (const l of st.listeners) {
              try {
                l(fanout)
              } catch (err) {
                logger.warn({ err }, 'transcript listener threw')
              }
            }
          }
        }
      }
      return
    }

    // Extract the opencode session id where we can.
    let ocSessionId: string | undefined
    if (type === 'message.updated') {
      ocSessionId = (props.info as { sessionID?: string } | undefined)?.sessionID
    } else if (type === 'message.part.updated') {
      ocSessionId = (props.part as { sessionID?: string } | undefined)?.sessionID
    } else if (type === 'permission.updated') {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else if (type === 'permission.replied') {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else if (type === 'session.idle') {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else if (type === 'session.error') {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else if (
      type === 'question.asked' ||
      type === 'question.replied' ||
      type === 'question.rejected'
    ) {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else if (type === 'todo.updated') {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else {
      return
    }

    if (!ocSessionId) return

    // Track pending approvals so sessionStatus can surface them.
    if (type === 'permission.updated') {
      const p = props as unknown as {
        id: string
        sessionID: string
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

    // Mirror message-updated to agent_transcripts so a later UI reload has
    // history even if the tab missed the event stream.
    if (type === 'message.updated') {
      await this.recordTranscript(ocSessionId, props)
    }

    const st = this.subs.get(sandboxId)
    if (!st) return
    const evt: TranscriptEvent = {
      type: type as TranscriptEvent['type'],
      sessionId: ocSessionId,
      payload: props,
    }
    for (const l of st.listeners) {
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
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.opencodeSessionId, opencodeSessionId))
      .limit(1)
    const row = rows[0]
    if (!row) return
    const nextSeq = (this.seqCounters.get(row.id) ?? 0) + 1
    this.seqCounters.set(row.id, nextSeq)
    try {
      await db.insert(agentTranscripts).values({
        sessionId: row.id,
        seq: nextSeq,
        role: info.role,
        contentJson: props as Record<string, unknown>,
      })
      await db
        .update(agentSessions)
        .set({ lastActivityAt: new Date() })
        .where(eq(agentSessions.id, row.id))
    } catch (err) {
      logger.warn({ err, id: row.id }, 'transcript insert failed')
    }
  }

  private async requireSession(id: string) {
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1)
    const row = rows[0]
    if (!row) throw new AgentError('not_found', `agent session ${id} not found`)
    return row
  }
}

export const agentService = new AgentService()

// Note: password is referenced indirectly via `resolveEndpoint`.
void getOpenCodePassword
