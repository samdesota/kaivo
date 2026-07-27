import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvPrincipal } from '../auth/principal.js'
import type { DispatchSubtaskInput, ProvisioningStage } from './contracts.js'

vi.mock('../agent/service.js', () => ({
  AgentError: class AgentError extends Error { constructor(public code: string, message: string) { super(message) } },
  agentService: {},
}))

vi.mock('../repo/service.js', () => ({
  RepoError: class RepoError extends Error {
    constructor(public code: string, message: string, public residualArtifacts: string[] = []) { super(message) }
  },
  repoService: {},
}))

let root = ''
let sqliteRaw: import('better-sqlite3').Database

const user: EnvPrincipal = { kind: 'user' }
const dispatchAgent: EnvPrincipal = {
  kind: 'agent', agentSessionId: 'dispatch-1', opencodeSessionId: 'oc-dispatch-1', workspaceId: 'workspace-1', sessionKind: 'dispatch',
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestration-service-'))
  vi.stubEnv('CC_STATE_DIR', root)
  vi.stubEnv('CC_WORKING_DIR', root)
  vi.stubEnv('CC_IDENTITY_URL', 'http://127.0.0.1:1')
  vi.resetModules()
  const migration = await import('../db/migrate.js')
  const client = await import('../db/client.js')
  sqliteRaw = client.sqliteRaw
  await migration.runMigrations()
  sqliteRaw.prepare("INSERT INTO env_meta (id, env_token_hash, paired_at) VALUES (1, 'hash', datetime('now'))").run()
  sqliteRaw.prepare(`
    INSERT INTO agent_sessions
      (id, workspace_id, opencode_session_id, title, status, kind, created_at, last_activity_at)
    VALUES
      ('dispatch-1', 'workspace-1', 'oc-dispatch-1', 'Dispatch', 'active', 'dispatch', datetime('now'), datetime('now')),
      ('dispatch-2', 'workspace-2', 'oc-dispatch-2', 'Other', 'active', 'dispatch', datetime('now'), datetime('now')),
      ('subtask-principal', 'workspace-1', 'oc-subtask-principal', 'Subtask', 'active', 'subtask', datetime('now'), datetime('now')),
      ('chat-principal', 'workspace-1', 'oc-chat-principal', 'Chat', 'active', 'chat', datetime('now'), datetime('now'))
  `).run()
})

afterEach(async () => {
  if (sqliteRaw?.open) sqliteRaw.close()
  vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})

function input(operationId: string): DispatchSubtaskInput {
  return {
    operationId,
    workspaceId: 'workspace-1',
    dispatchSessionId: 'dispatch-1',
    title: `Task ${operationId}`,
    instruction: `Do ${operationId}`,
    repositoryId: 'config-1',
    sourceRef: 'main',
    branchName: `task/${operationId}`,
    deliveryMode: 'dispatcher_integration',
  }
}

async function harness() {
  const { OrchestrationService } = await import('./service.js')
  const { RepoError } = await import('../repo/service.js')
  let cloneCount = 0
  let sessionCount = 0
  let sendCount = 0
  let failClone: 'no' | 'generic' | 'residual' = 'no'
  let failSession = false
  let failSend = false
  let faultStage: ProvisioningStage | null = null
  const faulted = new Set<string>()
  const messages = new Map<string, Array<{ parts: Array<Record<string, unknown>> }>>()
  const directories = new Map<string, string>()

  const service = new OrchestrationService({
    cloneWorktree: async (request) => {
      if (failClone !== 'no') {
        const kind = failClone
        failClone = 'no'
        if (kind === 'residual') throw new RepoError('clone_failed', 'clone cleanup interrupted', [path.join(root, 'residual-clone')])
        throw new Error('clone interrupted')
      }
      cloneCount++
      const repoId = `repo-${cloneCount}`
      const workingDir = path.join(root, request.worktreeName)
      await fs.mkdir(workingDir, { recursive: true })
      sqliteRaw.prepare(`
        INSERT INTO repos
          (id, config_id, name, slug, worktree_name, worktree_slug, origin_url, ref, workspace_path, source, created_at, workspace_id)
        VALUES (?, ?, 'Repo', 'repo', ?, ?, 'local', ?, ?, 'url', datetime('now'), ?)
      `).run(repoId, request.configId, request.worktreeName, request.worktreeName, request.sourceRef, workingDir, request.workspaceId)
      directories.set(repoId, workingDir)
      return { ...request, repoId, workingDir, name: 'Repo', resolvedCommit: 'abc123' }
    },
    deleteWorktree: async (repoId) => {
      const directory = directories.get(repoId)
      if (directory) await fs.rm(directory, { recursive: true, force: true })
      sqliteRaw.prepare('DELETE FROM repos WHERE id = ?').run(repoId)
    },
    createSession: async (request) => {
      if (failSession) { failSession = false; throw new Error('session interrupted') }
      sessionCount++
      const id = `task-session-${sessionCount}`
      const opencodeSessionId = `oc-task-${sessionCount}`
      sqliteRaw.prepare(`
        INSERT INTO agent_sessions
          (id, workspace_id, opencode_session_id, title, status, kind, working_dir, created_at, last_activity_at)
        VALUES (?, ?, ?, ?, 'active', 'subtask', ?, datetime('now'), datetime('now'))
      `).run(id, request.workspaceId, opencodeSessionId, request.title, request.directory)
      messages.set(id, [])
      return {
        id, workspaceId: request.workspaceId, opencodeSessionId, title: request.title,
        status: 'active', kind: 'subtask', workingDir: request.directory, createdAt: new Date(), lastActivityAt: new Date(),
      }
    },
    sendMessage: async (request) => {
      sendCount++
      if (failSend) { failSend = false; throw new Error('prompt interrupted') }
      messages.get(request.sessionId)?.push({ parts: [{ type: 'text', text: request.message }] })
    },
    messages: async (sessionId) => messages.get(sessionId) ?? [],
    afterStage: async (stage, subtaskId) => {
      if (faultStage === stage && !faulted.has(`${stage}:${subtaskId}`)) {
        faulted.add(`${stage}:${subtaskId}`)
        throw new Error(`crash after ${stage}`)
      }
    },
  })
  return {
    service,
    counts: () => ({ cloneCount, sessionCount, sendCount }),
    setFault: (stage: ProvisioningStage | null) => { faultStage = stage },
    failNextClone: () => { failClone = 'generic' },
    failNextCloneWithResidual: () => { failClone = 'residual' },
    failNextSession: () => { failSession = true },
    failNextSend: () => { failSend = true },
  }
}

describe('orchestration provisioning', () => {
  it('formats bounded task context with required Git metadata and no sibling state', async () => {
    const { formatSubtaskInitialPrompt } = await import('./service.js')
    const prompt = formatSubtaskInitialPrompt({
      operationId: 'operation-1',
      subtaskId: 'task-1',
      taskTitle: 'Implement parser',
      dispatchTitle: 'Compiler dispatch',
      deliveryMode: 'pull_request',
      sourceRef: 'refs/tags/v2.0.0',
      branchName: 'task/parser',
      instruction: 'Implement the parser without changing the lexer.',
    })
    expect(prompt).toContain('Task ID: task-1')
    expect(prompt).toContain('Dispatch: Compiler dispatch')
    expect(prompt).toContain('Delivery mode: pull_request')
    expect(prompt).toContain('Source ref: refs/tags/v2.0.0')
    expect(prompt).toContain('Branch: task/parser')
    expect(prompt).toContain('Implement the parser without changing the lexer.')
    expect(prompt).not.toContain('sibling')
    expect(prompt).not.toContain('transcript')
  })

  it('serializes concurrent deliveries of the same operation', async () => {
    const h = await harness()
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      h.service.dispatch(dispatchAgent, input('concurrent')),
    ))
    expect(new Set(results.map((result) => result.subtaskId)).size).toBe(1)
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1)
    expect(h.counts()).toEqual({ cloneCount: 1, sessionCount: 1, sendCount: 1 })
  })

  it('lazily promotes a workspace chat when its first dispatch is reserved', async () => {
    const h = await harness()
    const chatAgent: EnvPrincipal = {
      kind: 'agent', agentSessionId: 'chat-principal', opencodeSessionId: 'oc-chat-principal', workspaceId: 'workspace-1', sessionKind: 'chat',
    }
    const request = input('lazy-chat')
    const result = await h.service.dispatchFromAgent(chatAgent, {
      operationId: request.operationId,
      title: request.title,
      instruction: request.instruction,
      repositoryId: request.repositoryId,
      sourceRef: request.sourceRef,
      branchName: request.branchName,
      deliveryMode: request.deliveryMode,
    })

    expect(result.state).toBe('active')
    expect((sqliteRaw.prepare("SELECT kind FROM agent_sessions WHERE id = 'chat-principal'").get() as { kind: string }).kind).toBe('dispatch')
    expect((sqliteRaw.prepare("SELECT dispatch_session_id AS dispatchSessionId FROM orchestration_subtasks WHERE id = ?").get(result.subtaskId) as { dispatchSessionId: string }).dispatchSessionId).toBe('chat-principal')
    await expect(h.service.dispatchFromAgent(chatAgent, {
      operationId: request.operationId,
      title: request.title,
      instruction: request.instruction,
      repositoryId: request.repositoryId,
      sourceRef: request.sourceRef,
      branchName: request.branchName,
      deliveryMode: request.deliveryMode,
    })).resolves.toEqual(result)
    expect(h.counts()).toEqual({ cloneCount: 1, sessionCount: 1, sendCount: 1 })
  })

  it('does not resurrect returned or completed tasks through duplicate dispatch', async () => {
    const h = await harness()
    const returned = await h.service.dispatch(user, input('duplicate-returned'))
    h.service.recordReturn(returned.subtaskId, { assistantMessageId: 'assistant-returned', kind: 'response', summary: 'Ready' })
    await expect(h.service.dispatch(user, input('duplicate-returned'))).resolves.toMatchObject({ state: 'returned' })

    const completed = await h.service.dispatch(user, input('duplicate-completed'))
    h.service.complete(user, { workspaceId: 'workspace-1', subtaskId: completed.subtaskId })
    await expect(h.service.dispatch(user, input('duplicate-completed'))).resolves.toMatchObject({ state: 'completed' })
    expect(h.counts()).toEqual({ cloneCount: 2, sessionCount: 2, sendCount: 2 })
  })

  it('fault-injects every boundary and retries one operation without duplicate artifacts', async () => {
    const h = await harness()
    for (const stage of ['reserved', 'worktree_created', 'session_created', 'prompt_accepted'] as const) {
      h.setFault(stage)
      const first = await h.service.dispatch(user, input(`fault-${stage}`))
      expect(first.state).toBe('failed')
      expect(first.failure?.retryable).toBe(true)
      h.setFault(null)
      const recovered = await h.service.retry(user, { workspaceId: 'workspace-1', subtaskId: first.subtaskId })
      expect(recovered.state).toBe('active')
      expect(await h.service.dispatch(user, input(`fault-${stage}`))).toEqual(recovered)
      expect((sqliteRaw.prepare('SELECT count(*) AS count FROM orchestration_subtasks WHERE operation_id = ?').get(`fault-${stage}`) as { count: number }).count).toBe(1)
    }

    for (const [operation, fail] of [
      ['clone-error', h.failNextClone],
      ['session-error', h.failNextSession],
      ['prompt-error', h.failNextSend],
    ] as const) {
      fail()
      const first = await h.service.dispatch(user, input(operation))
      expect(first).toMatchObject({ state: 'failed', failure: { retryable: true, residualArtifacts: [] } })
      const recovered = await h.service.retry(user, { workspaceId: 'workspace-1', subtaskId: first.subtaskId })
      expect(recovered.state).toBe('active')
    }

    const duplicateCounts = sqliteRaw.prepare(`
      SELECT count(DISTINCT id) AS tasks, count(DISTINCT worktree_id) AS worktrees,
             count(DISTINCT session_id) AS sessions
      FROM orchestration_subtasks
    `).get() as { tasks: number; worktrees: number; sessions: number }
    expect(duplicateCounts).toEqual({ tasks: 7, worktrees: 7, sessions: 7 })

    h.failNextCloneWithResidual()
    await expect(h.service.dispatch(user, input('residual-clone'))).resolves.toMatchObject({
      state: 'failed',
      failure: { residualArtifacts: [`worktree_path:${path.join(root, 'residual-clone')}`] },
    })
  })

  it('reconciles checkpoints and makes missing worktrees and orphan sessions terminal', async () => {
    const h = await harness()
    for (const stage of ['reserved', 'worktree_created', 'session_created'] as const) {
      h.setFault(stage)
      const failed = await h.service.dispatch(user, input(`reconcile-${stage}`))
      h.setFault(null)
      await expect(h.service.reconcile(failed.subtaskId)).resolves.toMatchObject({ state: 'active' })
    }
    const active = await h.service.dispatch(user, input('missing-worktree'))
    await fs.rm(active.worktreePath!, { recursive: true, force: true })
    sqliteRaw.prepare("UPDATE orchestration_subtasks SET state = 'provisioning', provisioning_stage = 'worktree_created' WHERE id = ?").run(active.subtaskId)
    await expect(h.service.reconcile(active.subtaskId)).resolves.toMatchObject({
      state: 'failed', failure: { stage: 'worktree_integrity', retryable: false },
    })

    const orphan = await h.service.dispatch(user, input('orphan-session'))
    sqliteRaw.prepare("UPDATE orchestration_subtasks SET state = 'provisioning', provisioning_stage = 'reserved' WHERE id = ?").run(orphan.subtaskId)
    await expect(h.service.reconcile(orphan.subtaskId)).resolves.toMatchObject({
      state: 'failed', failure: { stage: 'reserved_integrity', retryable: false },
    })
    await expect(h.service.reconcileAll()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ subtaskId: active.subtaskId, outcome: 'failed' }),
      expect.objectContaining({ subtaskId: orphan.subtaskId, outcome: 'failed' }),
    ]))
  })

  it('enforces capability and workspace ownership at service and tRPC boundaries', async () => {
    const { hasCapability } = await import('../auth/principal.js')
    const h = await harness()
    const subtaskAgent: EnvPrincipal = {
      kind: 'agent', agentSessionId: 'subtask-principal', opencodeSessionId: 'oc-subtask-principal', workspaceId: 'workspace-1', sessionKind: 'subtask',
    }
    const chatAgent: EnvPrincipal = {
      kind: 'agent', agentSessionId: 'chat-principal', opencodeSessionId: 'oc-chat-principal', workspaceId: 'workspace-1', sessionKind: 'chat',
    }
    expect(hasCapability(user, 'orchestration:complete')).toBe(true)
    expect(hasCapability(dispatchAgent, 'orchestration:dispatch')).toBe(true)
    expect(hasCapability(dispatchAgent, 'orchestration:complete')).toBe(false)
    expect(hasCapability(subtaskAgent, 'orchestration:delivery:own')).toBe(true)
    expect(hasCapability(chatAgent, 'orchestration:read')).toBe(false)
    await expect(h.service.dispatch(subtaskAgent, input('denied-subtask'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.service.dispatch({ ...dispatchAgent, workspaceId: 'workspace-2' }, input('wrong-workspace'))).rejects.toMatchObject({ code: 'forbidden' })
    await expect(h.service.dispatch(dispatchAgent, input('allowed-dispatch'))).resolves.toMatchObject({ state: 'active' })

    const { orchestrationRouter } = await import('../trpc/routers/orchestration.js')
    const base = { req: { headers: {} } as never, res: {} as never }
    await expect(orchestrationRouter.createCaller({ ...base, envTokenPresent: false, agentShellTokenPresent: true, principal: null }).dispatch(input('unbound')))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(orchestrationRouter.createCaller({ ...base, envTokenPresent: false, agentShellTokenPresent: false, principal: subtaskAgent }).dispatch(input('router-subtask')))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('issues durable session-bound credentials that resolve after restart', async () => {
    const credentials = await import('../auth/session-credentials.js')
    const token = credentials.createAgentSessionCredential('dispatch-1')
    expect(credentials.resolveAgentSessionPrincipal(token)).toEqual(dispatchAgent)
    expect(credentials.resolveAgentSessionPrincipal('not-a-token')).toBeNull()
    vi.resetModules()
    const restarted = await import('../auth/session-credentials.js')
    expect(restarted.resolveAgentSessionPrincipal(token)).toEqual(dispatchAgent)
  })

  it('projects a stable workspace-scoped dispatch hierarchy', async () => {
    const h = await harness()
    const first = await h.service.dispatch(user, input('first'))
    const second = await h.service.dispatch(user, input('second'))
    const snapshot = h.service.snapshot(user, 'workspace-1', { generation: 'test', seq: 42 })
    expect(snapshot.cursor).toEqual({ generation: 'test', seq: 42 })
    expect(snapshot.dispatches.map((dispatch) => dispatch.id)).toEqual(['dispatch-1'])
    expect(snapshot.dispatches[0]?.subtasks.map((task) => task.id)).toEqual([first.subtaskId, second.subtaskId])
    expect(snapshot.dispatches[0]?.subtasks[0]).toMatchObject({
      title: 'Task first',
      state: 'active',
      sourceRef: 'main',
      branchName: 'task/first',
      failure: null,
    })
    expect(h.service.snapshot(user, 'workspace-2', { generation: 'test', seq: 43 }).dispatches.map((dispatch) => dispatch.id)).toEqual(['dispatch-2'])
    await expect(Promise.resolve().then(() => h.service.snapshot(dispatchAgent, 'workspace-2', { generation: 'test', seq: 0 })))
      .rejects.toMatchObject({ code: 'not_found' })
  })

  it('records each assistant return once and preserves history across follow-ups', async () => {
    const h = await harness()
    const active = await h.service.dispatch(user, input('returns'))
    expect(h.service.recordReturn(active.subtaskId, {
      assistantMessageId: 'assistant-1', kind: 'response', summary: 'First result',
    })).toMatchObject({ sequence: 1, summary: 'First result' })
    expect(h.service.recordReturn(active.subtaskId, {
      assistantMessageId: 'assistant-1', kind: 'response', summary: 'Duplicate event',
    })).toBeNull()
    const runtime = await import('../agent/runtime-realtime.js')
    runtime.getAgentRuntimeRealtime().upsert(runtime.AGENT_SESSION_RUNTIME_TABLE, {
      sessionId: active.sessionId!, workspaceId: 'workspace-1', running: true,
      pendingAttentionCount: 2, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
    let snapshot = h.service.snapshot(user, 'workspace-1', { generation: 'test', seq: 1 })
    expect(snapshot.dispatches[0]?.subtasks[0]).toMatchObject({
      state: 'returned', latestReturn: { assistantMessageId: 'assistant-1', summary: 'First result' },
      running: true, pendingAttentionCount: 2,
    })
    expect(h.service.resumeReturnedSubtask(active.sessionId!)).toBe(true)
    snapshot = h.service.snapshot(user, 'workspace-1', { generation: 'test', seq: 2 })
    expect(snapshot.dispatches[0]?.subtasks[0]?.state).toBe('active')
    expect(h.service.recordReturn(active.subtaskId, {
      assistantMessageId: 'assistant-2', kind: 'error', summary: 'Terminal failure',
    })).toMatchObject({ sequence: 2, kind: 'error' })
    expect(sqliteRaw.prepare('SELECT assistant_message_id FROM orchestration_returns ORDER BY sequence').all())
      .toEqual([{ assistant_message_id: 'assistant-1' }, { assistant_message_id: 'assistant-2' }])
  })

  it('deduplicates completed-message and idle observer signals while ignoring attention events', async () => {
    const h = await harness()
    const active = await h.service.dispatch(user, input('observer'))
    const messages = [{
      info: { id: 'assistant-observed', role: 'assistant', time: { completed: Date.now() } },
      parts: [{ type: 'text', text: 'Observed once' }],
    }]
    const { OrchestrationTurnObserver } = await import('./turn-observer.js')
    const observer = new OrchestrationTurnObserver(h.service, {
      subscribeEvents: () => () => undefined,
      subscribeSessionSends: () => () => undefined,
      subscribeSessionCreated: () => () => undefined,
      retainEventStream: () => () => undefined,
      openCodeSessionMessages: async () => messages,
    })
    await observer.observeEvent({
      type: 'message.updated', sessionId: 'oc-task-1',
      payload: { info: messages[0]!.info },
    })
    await observer.observeEvent({ type: 'session.idle', sessionId: 'oc-task-1', payload: {} })
    await observer.observeEvent({ type: 'question.asked', sessionId: 'oc-task-1', payload: {} })
    expect(sqliteRaw.prepare('SELECT assistant_message_id, summary FROM orchestration_returns WHERE subtask_id = ?').all(active.subtaskId))
      .toEqual([{ assistant_message_id: 'assistant-observed', summary: 'Observed once' }])
  })

  it('reconciles a missed terminal message at startup through the live deduplication path', async () => {
    const h = await harness()
    const active = await h.service.dispatch(user, input('startup-return'))
    const messages = [{
      info: { id: 'assistant-missed', role: 'assistant', time: { completed: Date.now() } },
      parts: [{ type: 'text', text: 'Recovered after restart' }],
    }]
    const { OrchestrationTurnObserver } = await import('./turn-observer.js')
    const observer = new OrchestrationTurnObserver(h.service, {
      subscribeEvents: () => () => undefined,
      subscribeSessionSends: () => () => undefined,
      subscribeSessionCreated: () => () => undefined,
      retainEventStream: () => () => undefined,
      openCodeSessionMessages: async () => messages,
    })
    await expect(observer.reconcileAll(2)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ opencodeSessionId: 'oc-task-1', outcome: 'reconciled' }),
    ]))
    await observer.reconcileOpencodeSession('oc-task-1')
    expect(sqliteRaw.prepare('SELECT assistant_message_id, summary FROM orchestration_returns WHERE subtask_id = ?').all(active.subtaskId))
      .toEqual([{ assistant_message_id: 'assistant-missed', summary: 'Recovered after restart' }])
    expect(h.service.get(user, 'workspace-1', active.subtaskId).state).toBe('returned')
  })

  it('publishes non-retryable worktree integrity failures and blocks sends', async () => {
    const h = await harness()
    const task = await h.service.dispatch(user, input('integrity-send'))
    await fs.rm(task.worktreePath!, { recursive: true, force: true })
    await expect(h.service.assertSessionSendable(task.sessionId!)).rejects.toMatchObject({ code: 'invalid_state' })
    const failed = h.service.get(user, 'workspace-1', task.subtaskId)
    expect(failed).toMatchObject({
      state: 'failed',
      failure: { stage: 'worktree_integrity', retryable: false },
    })
    expect(failed.failure?.residualArtifacts).toEqual(expect.arrayContaining([
      `worktree_path:${task.worktreePath}`,
      `agent_session:${task.sessionId}`,
    ]))
    await expect(h.service.assertSessionSendable(task.sessionId!)).rejects.toThrow('missing or moved')
    await expect(h.service.retry(user, { workspaceId: 'workspace-1', subtaskId: task.subtaskId })).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('formats current bounded dispatcher context from summaries, never sibling transcripts', async () => {
    const h = await harness()
    const task = await h.service.dispatch(user, input('context'))
    h.service.recordReturn(task.subtaskId, {
      assistantMessageId: 'assistant-context', kind: 'response', summary: `Current summary ${'x'.repeat(1_000)}`,
    })
    const first = h.service.dispatcherContext(dispatchAgent)
    expect(first).toContain('Current summary')
    expect(first).toContain('"state":"returned"')
    expect(first).not.toContain('Do context')
    expect(first.length).toBeLessThanOrEqual(12_000)
    h.service.resumeReturnedSubtask(task.sessionId!)
    const second = h.service.dispatcherContext(dispatchAgent)
    expect(second).toContain('"state":"active"')
    expect(second).not.toBe(first)
    expect(h.service.dispatcherContext({
      kind: 'agent', agentSessionId: 'chat-principal', opencodeSessionId: 'oc-chat-principal', workspaceId: 'workspace-1', sessionKind: 'chat',
    })).toBe('')
  })

  it('scopes delivery to the bound subtask and completes idempotently as user only', async () => {
    const h = await harness()
    const task = await h.service.dispatch(user, { ...input('delivery'), deliveryMode: 'pull_request' })
    const principal: EnvPrincipal = {
      kind: 'agent', agentSessionId: task.sessionId!, opencodeSessionId: 'oc-task-1', workspaceId: 'workspace-1', sessionKind: 'subtask',
    }
    expect(h.service.reportDelivery(principal, {
      pullRequestUrl: 'https://github.com/acme/repo/pull/42',
      headCommit: 'abc123',
      summary: 'Ready for review',
    })).toMatchObject({
      id: task.subtaskId,
      delivery: { pullRequestUrl: 'https://github.com/acme/repo/pull/42', headCommit: 'abc123', summary: 'Ready for review' },
    })
    expect(() => h.service.reportDelivery({ ...principal, agentSessionId: 'subtask-principal' }, { summary: 'spoofed' }))
      .toThrow('subtask not found')
    expect(() => h.service.complete(principal, { workspaceId: 'workspace-1', subtaskId: task.subtaskId }))
      .toThrow()

    const { getEnvRealtime } = await import('../realtime/env-realtime.js')
    getEnvRealtime()
    const changeCount = () => (sqliteRaw.prepare("SELECT count(*) AS count FROM cc_realtime_log WHERE table_name = 'orchestration_subtasks'").get() as { count: number }).count
    const beforeCompletion = changeCount()
    const first = h.service.complete(user, { workspaceId: 'workspace-1', subtaskId: task.subtaskId })
    const afterFirstCompletion = changeCount()
    const second = h.service.complete(user, { workspaceId: 'workspace-1', subtaskId: task.subtaskId })
    expect(first).toMatchObject({ state: 'completed', completedAt: expect.any(String) })
    expect(second.completedAt).toBe(first.completedAt)
    expect(afterFirstCompletion).toBe(beforeCompletion + 1)
    expect(changeCount()).toBe(afterFirstCompletion)
    expect(h.service.dispatcherContext(dispatchAgent)).toContain('https://github.com/acme/repo/pull/42')
    expect(h.service.dispatcherContext(dispatchAgent)).toContain(`"completedAt":"${first.completedAt}"`)
  })

  it('records a late return after completion without making the task actionable again', async () => {
    const h = await harness()
    const task = await h.service.dispatch(user, input('late-return'))
    h.service.complete(user, { workspaceId: 'workspace-1', subtaskId: task.subtaskId })
    expect(h.service.recordReturn(task.subtaskId, {
      assistantMessageId: 'assistant-late', kind: 'response', summary: 'Finished after completion',
    })).toMatchObject({ assistantMessageId: 'assistant-late' })
    const snapshot = h.service.snapshot(user, 'workspace-1', { generation: 'test', seq: 1 })
    expect(snapshot.dispatches[0]?.subtasks[0]).toMatchObject({
      state: 'completed', latestReturn: { assistantMessageId: 'assistant-late' },
    })
    expect(sqliteRaw.prepare('SELECT count(*) AS count FROM orchestration_returns WHERE subtask_id = ?').get(task.subtaskId))
      .toEqual({ count: 1 })
  })

  it('rejects archived dispatches and keeps archived subtasks readable and incomplete', async () => {
    const h = await harness()
    const task = await h.service.dispatch(user, input('archive'))
    sqliteRaw.prepare("UPDATE agent_sessions SET status = 'archived' WHERE id = 'dispatch-1'").run()
    await expect(h.service.dispatch(user, input('archive-new'))).rejects.toThrow('archived')
    await expect(h.service.dispatch(user, input('archive'))).rejects.toThrow('archived')

    sqliteRaw.prepare("UPDATE agent_sessions SET status = 'archived' WHERE id = ?").run(task.sessionId)
    expect(h.service.snapshot(user, 'workspace-1', { generation: 'test', seq: 1 }).dispatches[0]?.subtasks[0])
      .toMatchObject({ state: 'active', sessionStatus: 'archived', completedAt: null })
    sqliteRaw.prepare("UPDATE agent_sessions SET status = 'active' WHERE id = ?").run(task.sessionId)
    sqliteRaw.prepare("UPDATE agent_sessions SET status = 'active' WHERE id = 'dispatch-1'").run()
    expect(h.service.snapshot(user, 'workspace-1', { generation: 'test', seq: 2 }).dispatches[0]?.subtasks[0])
      .toMatchObject({ state: 'active', sessionStatus: 'active', completedAt: null })
    await expect(h.service.dispatch(user, input('archive-new'))).resolves.toMatchObject({ state: 'active' })
  })

  it('mirrors each return through a retryable outbox without changing durable task state', async () => {
    const h = await harness()
    const task = await h.service.dispatch(user, input('notification'))
    h.service.recordReturn(task.subtaskId, {
      assistantMessageId: 'assistant-notification', kind: 'response', summary: 'Ready for review',
    })
    const sent: Array<Record<string, unknown>> = []
    let fail = true
    const { ReturnNotificationMirror } = await import('./return-notification-mirror.js')
    const mirror = new ReturnNotificationMirror(async (value) => {
      if (fail) { fail = false; throw new Error('identity unavailable') }
      sent.push(value)
    })
    await mirror.drain()
    expect(sqliteRaw.prepare('SELECT attempts, delivered_at FROM orchestration_return_notification_outbox').get())
      .toEqual({ attempts: 1, delivered_at: null })
    await mirror.drain()
    await mirror.drain()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ idempotencyKey: expect.stringMatching(/^orchestration-return:/), sessionId: task.sessionId, summary: 'Ready for review' })
    expect(h.service.snapshot(user, 'workspace-1', { generation: 'test', seq: 3 }).dispatches[0]?.subtasks[0])
      .toMatchObject({ state: 'returned', latestReturn: { summary: 'Ready for review' }, completedAt: null })
  })
})
