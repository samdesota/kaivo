import http from 'node:http'
import { expect, test, type Page } from '@playwright/test'

test('a regular workspace chat lazily dispatches and opens a sidebar subtask', async ({ page }) => {
  const env = await startOrchestrationEnv()
  try {
    await openWorkspace(page, env.url, `Orchestration ${Date.now()}`)
    await createWorkspaceChat(page)
    await expect(page.getByRole('button', { name: /Task state/ })).toHaveCount(0)

    await sendMessage(page, 'Launch parser task from refs/heads/main into task/parser.')
    await page.reload()
    await waitForAppDataReady(page)
    const task = sidebarTask(page, /Implement parser/)
    await expect(task).toBeVisible({ timeout: 8_000 })
    await task.click()
    await expect(page.locator('[data-orchestration-chat]').getByText('Subtask ready on task/parser.')).toBeVisible()
    await expect(page.locator('[data-orchestration-chat]').getByRole('button', { name: /Implement parser.*returned/ })).toBeVisible()

    await sendMessage(page, 'Run the parser tests independently.')
    await page.reload()
    await waitForAppDataReady(page)
    await sidebarTask(page, /Implement parser/).click()
    await expect(page.locator('[data-orchestration-chat]').getByText('Independent parser tests passed.')).toBeVisible()
  } finally {
    await env.close()
  }
})

test('the task banner provides completion metadata without a second navigator', async ({ page }) => {
  const env = await startOrchestrationEnv()
  try {
    await openWorkspace(page, env.url, `Task banner ${Date.now()}`)
    await createWorkspaceChat(page)
    await sendMessage(page, 'Launch an independent PR task.')
    await page.reload()
    await waitForAppDataReady(page)
    await sidebarTask(page, /Implement parser/).click()
    expect(await page.getByLabel('Orchestration navigator').count()).toBe(0)
    const banner = page.locator('[data-orchestration-chat]').getByRole('button', { name: /Implement parser.*returned/ })
    await banner.click()
    await expect(page.getByText('https://github.com/acme/parser/pull/42')).toBeVisible()
    await page.getByRole('button', { name: 'Mark complete' }).click()
    await expect(page.getByText(/Mark task complete/)).toBeVisible()
  } finally {
    await env.close()
  }
})

test('sidebar task rows preserve attention and return summaries', async ({ page }) => {
  const env = await startOrchestrationEnv()
  try {
    await openWorkspace(page, env.url, `Attention orchestration ${Date.now()}`)
    await createWorkspaceChat(page)
    await sendMessage(page, 'Create attention and terminal-turn fixtures.')
    await page.reload()
    await waitForAppDataReady(page)
    await expect(sidebarTask(page, /Question pending.*1 needs attention/)).toBeVisible()
    await expect(sidebarTask(page, /Permission pending.*1 needs attention/)).toBeVisible()
    await expect(sidebarTask(page, /Tool-only turn.*Completed tool turn: bash/)).toBeVisible()
    await expect(sidebarTask(page, /Errored turn.*Provider terminal error/)).toBeVisible()
  } finally {
    await env.close()
  }
})

async function createWorkspaceChat(page: Page) {
  await page.getByRole('button', { name: 'Start a new agent chat' }).click()
  await page.getByPlaceholder(/Search folders/).fill('/tmp/project')
  await page.getByRole('button', { name: /Use this folder/ }).click()
  await page.getByRole('button', { name: 'Create chat' }).click()
  await expect(page.getByPlaceholder(/Message the agent|Follow up/)).toBeVisible()
}

async function sendMessage(page: Page, message: string) {
  const composer = page.getByPlaceholder(/Message the agent|Follow up/)
  await composer.fill(message)
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/trpc/agent.sessionSend') && response.ok()),
    composer.press('Enter'),
  ])
}

function sidebarTask(page: Page, name: RegExp) {
  return page.locator('aside[aria-label="Workspaces"] [data-current-workspace="true"]').getByRole('button', { name }).first()
}

async function openWorkspace(page: Page, envUrl: string, name: string) {
  await login(page)
  const workspace = await trpcMutation<{ id: string }>(page, 'workspace.create', { name })
  await trpcMutation(page, 'env.registerLocal', {
    url: envUrl,
    envToken: 'orchestration-token-123',
    label: `Orchestration env ${envUrl}`,
    localIdentityLabel: `playwright-${new URL(envUrl).port}`,
  })
  await page.goto(`/w/${workspace.id}`)
  await waitForAppDataReady(page)
}

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Password').fill('e2e-password-123')
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/trpc/auth.login') && response.ok()),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ])
}

async function waitForAppDataReady(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { __kaivoAppDataReady?: boolean; __kaivoAppDataError?: string }
    return state.__kaivoAppDataReady ? 'ready' : (state.__kaivoAppDataError ?? 'pending')
  })).toBe('ready')
}

async function trpcMutation<T>(page: Page, path: string, input?: unknown): Promise<T> {
  return await page.evaluate(async ({ path, input }) => {
    const response = await fetch(`/trpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ json: input }),
    })
    if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`)
    const json = await response.json() as { result?: { data?: { json?: unknown } } }
    return json.result?.data?.json
  }, { path, input }) as T
}

async function startOrchestrationEnv(): Promise<{
  url: string
  close: () => Promise<void>
  restart: () => Promise<void>
  recoverProvisioning: () => void
  retryCount: () => number
  replacementRequests: () => number
  enableParallel: () => void
  reverseSnapshots: () => void
  archiveDispatch: () => void
  reopenDispatch: () => void
  dispatchAllowed: () => boolean
}> {
  const state: MockState = {
    dispatchCreated: false,
    subtaskCreated: false,
    attentionFixtures: false,
    taskMessages: [] as string[],
    deliveryMode: 'dispatcher_integration',
    delivery: { pullRequestUrl: null, headCommit: null, summary: null },
    completedAt: null,
    taskAttention: 0,
    recoveryMode: null,
    retryCount: 0,
    replacementRequests: 0,
    parallel: false,
    reversed: false,
    dispatchArchived: false,
    taskArchived: false,
  }
  const listener = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    setCors(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.url === '/healthz') {
      sendJson(response, { ok: true, kind: 'local', label: 'Orchestration env', paired: true })
      return
    }
    const requestUrl = request.url ?? ''
    if (!requestUrl.startsWith('/trpc/')) {
      response.writeHead(404)
      response.end()
      return
    }
    const url = new URL(requestUrl, 'http://127.0.0.1')
    const procedures = decodeURIComponent(url.pathname.slice('/trpc/'.length)).split(',')
    const batch = url.searchParams.get('batch') === '1'
    const body = await readBody(request)
    const encodedInput = request.method === 'GET' ? url.searchParams.get('input') : body
    const parsed = encodedInput ? JSON.parse(encodedInput) as Record<string, { json?: unknown }> & { json?: unknown } : {}
    const results = procedures.map((procedure, index) => {
      const input = batch ? parsed[String(index)]?.json : parsed.json
      return handleProcedure(procedure, input, state)
    })
    sendJson(response, batch ? results : results[0])
  }
  let server = http.createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock env server did not bind')
  const port = address.port
  const closeServer = async () => {
    const current = server
    await new Promise<void>((resolve, reject) => {
      current.close((error) => error ? reject(error) : resolve())
      current.closeAllConnections()
    })
  }
  return {
    url: `http://127.0.0.1:${port}`,
    close: closeServer,
    restart: async () => {
      await closeServer()
      server = http.createServer(listener)
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    },
    recoverProvisioning: () => { state.recoveryMode = null },
    retryCount: () => state.retryCount,
    replacementRequests: () => state.replacementRequests,
    enableParallel: () => { state.parallel = true },
    reverseSnapshots: () => { state.reversed = true },
    archiveDispatch: () => { state.dispatchArchived = true },
    reopenDispatch: () => { state.dispatchArchived = false },
    dispatchAllowed: () => !state.dispatchArchived,
  }
}

type MockState = {
  dispatchCreated: boolean
  subtaskCreated: boolean
  attentionFixtures: boolean
  taskMessages: string[]
  deliveryMode: 'pull_request' | 'dispatcher_integration'
  delivery: { pullRequestUrl: string | null; headCommit: string | null; summary: string | null }
  completedAt: string | null
  taskAttention: number
  recoveryMode: 'progress' | 'retryable' | 'integrity' | null
  retryCount: number
  replacementRequests: number
  parallel: boolean
  reversed: boolean
  dispatchArchived: boolean
  taskArchived: boolean
}

function handleProcedure(
  procedure: string,
  input: unknown,
  state: MockState,
) {
  const now = new Date().toISOString()
  if (procedure === 'orchestration.startDispatch') {
    state.dispatchCreated = true
    return trpcResult({ id: 'dispatch-1', kind: 'dispatch' })
  }
  if (procedure === 'agent.sessionStart') {
    state.dispatchCreated = true
    return trpcResult({ id: 'dispatch-1', kind: 'chat' })
  }
  if (procedure === 'agent.sessionSend') {
    const message = (input as { message?: string } | undefined)?.message ?? ''
    const sessionId = (input as { sessionId?: string } | undefined)?.sessionId
    if (sessionId === 'dispatch-1') {
      if (message.includes('replacement task')) state.replacementRequests++
      if (message.includes('attention and terminal-turn')) state.attentionFixtures = true
      else {
        state.subtaskCreated = true
        if (message.includes('retryable provisioning')) state.recoveryMode = 'retryable'
        else if (message.includes('reload recovery')) state.recoveryMode = 'progress'
        else if (message.includes('missing worktree')) state.recoveryMode = 'integrity'
        if (message.includes('independent PR')) {
          state.deliveryMode = 'pull_request'
          state.delivery = { pullRequestUrl: 'https://github.com/acme/parser/pull/42', headCommit: 'abc123', summary: 'PR ready for review' }
        }
        if (message.includes('dispatcher integration')) {
          state.deliveryMode = 'dispatcher_integration'
          state.delivery = { pullRequestUrl: null, headCommit: 'deadbeef', summary: 'Commit ready for dispatcher integration' }
          state.taskAttention = 1
        }
      }
    }
    if (sessionId === 'task-session-1') state.taskMessages.push(message)
    return trpcResult({ ok: true, queued: false })
  }
  if (procedure === 'orchestration.complete') {
    state.completedAt ??= now
    return trpcResult(standardTask(state, now))
  }
  if (procedure === 'orchestration.retry') {
    state.retryCount++
    state.recoveryMode = null
    return trpcResult(standardTask(state, now))
  }
  if (procedure === 'agent.sessionClose' || procedure === 'agent.sessionReopen') {
    const sessionId = (input as { sessionId?: string } | undefined)?.sessionId
    const archived = procedure === 'agent.sessionClose'
    if (sessionId === 'dispatch-1') state.dispatchArchived = archived
    if (sessionId === 'task-session-1') state.taskArchived = archived
    return trpcResult({ id: sessionId, status: archived ? 'archived' : 'active' })
  }
  if (procedure === 'agent.sessionList') {
    return trpcResult(state.dispatchCreated ? [{
      id: 'dispatch-1', workspaceId: (input as { workspaceId?: string } | undefined)?.workspaceId ?? null,
       title: 'Release dispatch', status: state.dispatchArchived ? 'archived' : 'active', kind: state.subtaskCreated || state.attentionFixtures ? 'dispatch' : 'chat', workingDir: '/tmp/project', createdAt: '2026-07-21T00:00:00Z', lastActivityAt: now,
    }] : [])
  }
  if (procedure === 'orchestration.snapshot') {
    const standardTasks = state.subtaskCreated ? [standardTask(state, now)] : []
    const attentionTasks = state.attentionFixtures ? [
      mockTask('question', 'Question pending', 'active', null, 1, now),
      mockTask('permission', 'Permission pending', 'active', null, 1, now),
      mockTask('tool', 'Tool-only turn', 'returned', { kind: 'response', summary: 'Completed tool turn: bash (completed)' }, 0, now),
      mockTask('error', 'Errored turn', 'returned', { kind: 'error', summary: 'Provider terminal error' }, 0, now),
    ] : []
    const dispatches = state.subtaskCreated || state.attentionFixtures ? [{
      id: 'dispatch-1', title: 'Release dispatch', status: state.dispatchArchived ? 'archived' : 'active', workingDir: '/tmp/project', createdAt: '2026-07-21T00:00:00Z', lastActivityAt: now,
      subtasks: [...standardTasks, ...attentionTasks],
    }, ...(state.parallel ? [parallelDispatch(now)] : [])] : []
    return trpcResult({ cursor: { generation: 'mock', seq: state.taskMessages.length }, dispatches: state.reversed ? [...dispatches].reverse() : dispatches })
  }
  if (procedure === 'agent.openCodeSessionMessages') {
    const sessionId = (input as { sessionId?: string } | undefined)?.sessionId
    if (sessionId === 'task-session-parallel-returned') {
      return trpcResult([message('assistant-parallel', 'assistant', 'Second dispatch transcript only.', sessionId)])
    }
    if (sessionId !== 'task-session-1') return trpcResult([])
    const messages = [message('assistant-ready', 'assistant', 'Subtask ready on task/parser.', 'task-session-1')]
    state.taskMessages.forEach((text, index) => {
      messages.push(message(`user-${index}`, 'user', text, 'task-session-1'))
      messages.push(message(`assistant-${index}`, 'assistant', 'Independent parser tests passed.', 'task-session-1'))
    })
    return trpcResult(messages)
  }
  if (procedure === 'agent.agentStatus') return trpcResult({ hasProvider: true, ready: true })
  if (procedure === 'agent.sessionStatus') return trpcResult({ status: 'active', running: false, pendingApprovals: [], pendingQuestions: [], queuedMessages: [] })
  if (procedure === 'agent.transcriptLatestSeq') return trpcResult({ seq: 0 })
  if (procedure === 'agent.transcriptReplay' || procedure === 'agent.childTranscripts') return trpcResult([])
  if (procedure === 'agent.listCommands' || procedure === 'repo.listConfigs' || procedure === 'repo.listWorktrees' || procedure === 'repo.list') return trpcResult([])
  if (procedure === 'repo.listRecentFolders') return trpcResult([{ path: '/tmp/project', label: 'Project', lastOpenedAt: now }])
  if (procedure === 'fs.browseHome') return trpcResult({ path: '/tmp/project', home: '/tmp', defaultPath: '/tmp', dirs: [], files: [] })
  if (procedure === 'agent.listModels') return trpcResult([])
  if (procedure === 'agent.sessionGetModel') return trpcResult(null)
  if (procedure === 'agentRuntime.snapshot') return trpcResult({ table: 'agent_session_runtime', rows: [], seq: 0 })
  return trpcResult(null)
}

function mockTask(
  id: string,
  title: string,
  state: 'active' | 'returned',
  latest: { kind: 'response' | 'error'; summary: string } | null,
  attention: number,
  now: string,
) {
  return {
    id: `task-${id}`, dispatchSessionId: 'dispatch-1', sessionId: `session-${id}`, sessionStatus: 'active', title, state,
    provisioningStage: 'prompt_accepted', sourceRef: 'main', branchName: `task/${id}`, deliveryMode: 'dispatcher_integration',
    delivery: { pullRequestUrl: null, headCommit: null, summary: null }, worktreePath: `/tmp/${id}`, failure: null,
    latestReturn: latest ? { id: `return-${id}`, sequence: 1, subtaskId: `task-${id}`, assistantMessageId: `assistant-${id}`, ...latest, createdAt: now } : null,
    running: false, pendingAttentionCount: attention, completedAt: null, createdAt: now, updatedAt: now,
  }
}

function parallelDispatch(now: string) {
  const task = (
    id: string,
    state: 'active' | 'returned' | 'failed' | 'completed',
    options: { running?: boolean; attention?: number; summary?: string; failure?: string } = {},
  ) => ({
    id: `parallel-${id}`,
    dispatchSessionId: 'dispatch-2',
    sessionId: `task-session-parallel-${id}`,
    sessionStatus: 'active',
    title: `Parallel ${id}`,
    state,
    provisioningStage: 'prompt_accepted',
    sourceRef: 'main',
    branchName: `task/parallel-${id}`,
    deliveryMode: 'dispatcher_integration',
    delivery: { pullRequestUrl: null, headCommit: state === 'completed' ? 'complete123' : null, summary: null },
    worktreePath: `/tmp/parallel-${id}`,
    failure: options.failure ? { stage: 'session_created', message: options.failure, retryable: false, residualArtifacts: [] } : null,
    latestReturn: options.summary ? {
      id: `return-parallel-${id}`, sequence: 20, subtaskId: `parallel-${id}`,
      assistantMessageId: `assistant-parallel-${id}`, kind: 'response', summary: options.summary, createdAt: now,
    } : null,
    running: options.running ?? false,
    pendingAttentionCount: options.attention ?? 0,
    completedAt: state === 'completed' ? now : null,
    createdAt: `2026-07-21T00:00:0${id === 'active' ? 1 : id === 'returned' ? 2 : id === 'attention' ? 3 : id === 'failed' ? 4 : 5}Z`,
    updatedAt: now,
  })
  return {
    id: 'dispatch-2', title: 'Parallel dispatch', status: 'active', workingDir: '/tmp/parallel',
    createdAt: '2026-07-21T00:01:00Z', lastActivityAt: now,
    subtasks: [
      task('active', 'active', { running: true }),
      task('returned', 'returned', { summary: 'Second dispatch returned work' }),
      task('attention', 'active', { attention: 1 }),
      task('failed', 'failed', { failure: 'Parallel task failed' }),
      task('completed', 'completed'),
    ],
  }
}

function standardTask(state: MockState, now: string) {
  if (state.recoveryMode === 'progress') {
    return {
      ...standardTaskBase(state, now), sessionId: null, state: 'provisioning', provisioningStage: 'worktree_created',
      worktreePath: '/tmp/parser', failure: null, latestReturn: null,
    }
  }
  if (state.recoveryMode === 'retryable') {
    return {
      ...standardTaskBase(state, now), sessionId: null, state: 'failed', provisioningStage: 'session_created',
      worktreePath: '/tmp/parser', failure: { stage: 'session_created', message: 'OpenCode unavailable', retryable: true, residualArtifacts: ['repository_row:repo-partial'] }, latestReturn: null,
    }
  }
  if (state.recoveryMode === 'integrity') {
    return {
      ...standardTaskBase(state, now), state: 'failed', provisioningStage: 'prompt_accepted',
      failure: { stage: 'worktree_integrity', message: 'Provisioned worktree is missing or moved', retryable: false, residualArtifacts: ['worktree_path:/tmp/parser'] },
    }
  }
  return standardTaskBase(state, now)
}

function standardTaskBase(state: MockState, now: string) {
  return {
    id: 'task-1', dispatchSessionId: 'dispatch-1', sessionId: 'task-session-1', sessionStatus: state.taskArchived ? 'archived' : 'active', title: 'Implement parser', state: state.completedAt ? 'completed' : 'returned',
    provisioningStage: 'prompt_accepted', sourceRef: 'refs/heads/main', branchName: 'task/parser', deliveryMode: state.deliveryMode,
    delivery: state.delivery, worktreePath: '/tmp/parser', failure: null,
    latestReturn: {
      id: 'return-latest', sequence: state.taskMessages.length + 1, subtaskId: 'task-1',
      assistantMessageId: `assistant-${state.taskMessages.length}`, kind: 'response',
      summary: state.taskMessages.length > 0 ? 'Independent parser tests passed.' : 'Subtask ready on task/parser.', createdAt: now,
    },
    running: false, pendingAttentionCount: state.taskAttention, completedAt: state.completedAt, createdAt: now, updatedAt: now,
  }
}

function message(id: string, role: 'user' | 'assistant', text: string, sessionID: string) {
  return {
    info: { id, role, sessionID, time: { created: Date.now(), completed: Date.now() } },
    parts: [{ id: `${id}-text`, messageID: id, sessionID, type: 'text', text }],
  }
}

function trpcResult(json: unknown) {
  return { result: { data: { json } } }
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function setCors(response: http.ServerResponse) {
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  response.setHeader('access-control-allow-headers', 'authorization,content-type,trpc-accept')
}

function sendJson(response: http.ServerResponse, body: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}
