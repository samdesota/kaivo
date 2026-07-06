import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import Database from 'better-sqlite3'
import { expect, test, type Page } from '@playwright/test'
import { mockLlmText, startMockLlmServer, type MockLlmServer } from './helpers/mock-llm-server'

type LaunchManifest = {
  servers: Array<{ name: string; baseUrl: string; healthUrl?: string; logPath?: string }>
  storage: { envDbPath: string; envWorkspacePath: string }
}

const e2eAgentEventToken = 'opencode-e2e-agent-event-token'

test('real OpenCode stack responds through mocked LLM from the UI', async ({ page }) => {
  test.setTimeout(180_000)
  const harness = await startRealOpenCodeHarness()
  try {
    const clientUrl = serverUrl(harness.manifest, 'client')
    await login(page, clientUrl)
    const workspace = await appTrpcMutation<{ id: string; name: string }>(page, 'workspace.create', {
      name: `Real OpenCode ${Date.now()}`,
    })

    await page.goto(`${clientUrl}/w/${workspace.id}`)
    await waitForAppDataReady(page)
    await openFirstFolderChat(page)
    await expect(page.getByText('No messages yet.')).toBeVisible({ timeout: 60_000 })

    await page.getByPlaceholder(/Message the agent/).fill('Say hello from the mocked E2E LLM')
    await page.getByRole('button', { name: 'Send message' }).click()

    await expect(page.getByText('Agent is responding')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(mockLlmText())).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('Agent is responding')).toBeHidden({ timeout: 60_000 })
    await expect.poll(() => harness.llm.requests.some((request) => request.path.includes('/responses') || request.path.includes('/chat/completions'))).toBe(true)
    const env = await localEnvRegistration(page)
    const session = latestAgentSession(harness.manifest.storage.envDbPath)
    await expectRawAgentMessages(harness.manifest, env.envToken, session.opencodeSessionId, mockLlmText())
    await expectUnauthorizedRawAgentMessages(harness.manifest, session.opencodeSessionId)
    expect(transcriptRoleCounts(harness.manifest.storage.envDbPath, ['message.updated', 'message.part.updated'])).toEqual({
      'message.updated': 0,
      'message.part.updated': 0,
    })

    await page.reload()
    await waitForAppDataReady(page)
    await expect(page.getByText(mockLlmText())).toBeVisible({ timeout: 60_000 })
    expect(transcriptRoleCounts(harness.manifest.storage.envDbPath, ['message.updated', 'message.part.updated'])).toEqual({
      'message.updated': 0,
      'message.part.updated': 0,
    })

    await injectAgentEvent(harness.manifest, {
      type: 'permission.updated',
      properties: {
        id: 'e2e-permission-1',
        sessionID: session.opencodeSessionId,
        permission: 'bash',
        pattern: 'npm test',
        time: { created: Date.now() },
      },
    })
    await page.reload()
    await waitForAppDataReady(page)
    await expect(page.getByRole('button', { name: 'Allow all', exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('bash: npm test')).toBeVisible()
    expect(transcriptRoleCounts(harness.manifest.storage.envDbPath, ['permission.updated'])).toEqual({
      'permission.updated': 0,
    })

    const nonDefaultDir = path.join(harness.manifest.storage.envWorkspacePath, 'gateway-non-default')
    await fs.mkdir(nonDefaultDir, { recursive: true })
    const nonDefaultSession = await envTrpcMutation<{ id: string; opencodeSessionId: string }>(harness.manifest, env.envToken, 'agent.sessionStart', {
      title: 'Gateway non-default directory',
      directory: nonDefaultDir,
      prompt: 'Respond from the non-default gateway directory',
    })
    await expectRawAgentMessages(harness.manifest, env.envToken, nonDefaultSession.opencodeSessionId, mockLlmText(), nonDefaultDir)

    harness.llm.failAllRequests('Mocked persisted session error')
    await page.getByPlaceholder(/Message the agent/).fill('Trigger a mocked provider error')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText(/Mocked persisted session error/)).toBeVisible({ timeout: 120_000 })
    expect(transcriptRoleCounts(harness.manifest.storage.envDbPath, ['session.error'])['session.error']).toBeGreaterThanOrEqual(1)

    await page.reload()
    await waitForAppDataReady(page)
    await expect(page.getByText(/Mocked persisted session error/)).toBeVisible({ timeout: 60_000 })
  } catch (err) {
    console.error('mock LLM requests:', JSON.stringify(harness.llm.requests, null, 2))
    console.error(await collectLaunchLogs(harness.manifest))
    throw err
  } finally {
    await harness.close()
  }
})

async function startRealOpenCodeHarness(): Promise<{
  llm: MockLlmServer
  manifest: LaunchManifest
  close: () => Promise<void>
}> {
  const llm = await startMockLlmServer()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaivo-opencode-e2e-'))
  const instanceId = `opencode-e2e-${process.pid}-${Date.now()}`
  const instanceRoot = path.join(root, 'instance')
  let child: ChildProcessWithoutNullStreams | null = null
  try {
    child = spawn('npm', ['run', 'dev:web'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: path.join(root, 'home'),
        CC_INSTANCE_ID: instanceId,
        CC_INSTANCE_ROOT: instanceRoot,
        CC_SEED_OPENAI_API_KEY: 'mock-openai-key',
        CC_SEED_OPENAI_API_KEY_OP_REF: '',
        CC_SEED_OPENAI_BASE_URL: llm.url,
        CC_SEED_MODEL_PROVIDER: 'openai',
        CC_SEED_MODEL_ID: 'gpt-5.5',
        CC_SERVICE_CREDENTIAL: 'opencode-e2e-service-credential',
        CC_E2E_AGENT_EVENT_TOKEN: e2eAgentEventToken,
      },
    })
    const manifest = await waitForManifest(instanceRoot)
    return {
      llm,
      manifest,
      close: async () => {
        await stopProcess(child)
        await llm.close()
        await fs.rm(root, { recursive: true, force: true })
      },
    }
  } catch (err) {
    await stopProcess(child)
    await llm.close()
    await fs.rm(root, { recursive: true, force: true })
    throw err
  }
}

async function waitForManifest(instanceRoot: string): Promise<LaunchManifest> {
  const manifestPath = path.join(instanceRoot, 'launch.json')
  const deadline = Date.now() + 90_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(manifestPath, 'utf8')
      const manifest = JSON.parse(raw) as LaunchManifest
      const client = serverUrl(manifest, 'client')
      const res = await fetch(client)
      if (res.ok) return manifest
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`timed out waiting for local launch manifest: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function stopProcess(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    setTimeout(resolve, 2_000).unref()
  })
}

function serverUrl(manifest: LaunchManifest, name: string): string {
  const url = manifest.servers.find((server) => server.name === name)?.baseUrl
  if (!url) throw new Error(`manifest missing ${name} server`)
  return url
}

function transcriptRoleCounts(dbPath: string, roles: string[]): Record<string, number> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare(`select role, count(*) as count from agent_transcripts where role in (${roles.map(() => '?').join(',')}) group by role`).all(...roles) as Array<{ role: string; count: number }>
    const counts = Object.fromEntries(roles.map((role) => [role, 0])) as Record<string, number>
    for (const row of rows) counts[row.role] = row.count
    return counts
  } finally {
    db.close()
  }
}

function latestAgentSession(dbPath: string): { id: string; opencodeSessionId: string } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('select id, opencode_session_id as opencodeSessionId from agent_sessions order by last_activity_at desc limit 1').get() as { id: string; opencodeSessionId: string } | undefined
    if (!row) throw new Error('no agent session found')
    return row
  } finally {
    db.close()
  }
}

async function localEnvRegistration(page: Page): Promise<{ id: string; url: string; envToken: string }> {
  const envs = await appTrpcQuery<{ id: string; kind: string; status: string; url: string; envToken: string | null }[]>(page, 'env.list', {})
  const env = envs.find((candidate) => candidate.kind === 'local' && candidate.status === 'running' && candidate.envToken)
  if (!env?.envToken) throw new Error('local env registration with token not found')
  return { id: env.id, url: env.url, envToken: env.envToken }
}

async function expectRawAgentMessages(
  manifest: LaunchManifest,
  envToken: string,
  opencodeSessionId: string,
  expectedText: string,
  directory?: string,
): Promise<void> {
  await expect.poll(async () => {
    const messages = await fetchRawAgentMessages(manifest, envToken, opencodeSessionId, directory)
    return JSON.stringify(messages).includes(expectedText)
  }, { timeout: 60_000 }).toBe(true)
}

async function expectUnauthorizedRawAgentMessages(manifest: LaunchManifest, opencodeSessionId: string): Promise<void> {
  const res = await fetch(`${serverUrl(manifest, 'env')}/agent/session/${encodeURIComponent(opencodeSessionId)}/message`)
  expect(res.status).toBe(401)
}

async function fetchRawAgentMessages(
  manifest: LaunchManifest,
  envToken: string,
  opencodeSessionId: string,
  directory?: string,
): Promise<unknown> {
  const url = new URL(`${serverUrl(manifest, 'env')}/agent/session/${encodeURIComponent(opencodeSessionId)}/message`)
  const headers: Record<string, string> = { authorization: `Bearer ${envToken}` }
  if (directory) {
    url.searchParams.set('directory', directory)
    headers['x-opencode-directory'] = directory
  }
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`raw agent messages failed: ${res.status} ${await res.text()}`)
  return await res.json()
}

async function injectAgentEvent(manifest: LaunchManifest, event: unknown): Promise<void> {
  const res = await fetch(`${serverUrl(manifest, 'env')}/__e2e/agent-event`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kaivo-e2e-token': e2eAgentEventToken,
    },
    body: JSON.stringify(event),
  })
  if (!res.ok) throw new Error(`agent event injection failed: ${res.status} ${await res.text()}`)
}

async function collectLaunchLogs(manifest: LaunchManifest): Promise<string> {
  const out: string[] = []
  for (const server of manifest.servers) {
    if (!server.logPath) continue
    try {
      const raw = await fs.readFile(server.logPath, 'utf8')
      out.push(`--- ${server.name} log tail ---\n${raw.slice(-8_000)}`)
    } catch (err) {
      out.push(`--- ${server.name} log unavailable: ${err instanceof Error ? err.message : String(err)} ---`)
    }
  }
  return out.join('\n')
}

async function login(page: Page, clientUrl: string): Promise<void> {
  await page.goto(`${clientUrl}/login`)
  await page.getByLabel('Password').fill('password')
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/trpc/auth.login') && response.ok()),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ])
}

async function waitForAppDataReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { __kaivoAppDataReady?: boolean; __kaivoAppDataError?: string }
    return state.__kaivoAppDataReady ? 'ready' : (state.__kaivoAppDataError ?? 'pending')
  }), { timeout: 60_000 }).toBe('ready')
}

async function appTrpcMutation<T>(page: Page, path: string, input?: unknown): Promise<T> {
  return await page.evaluate(async ({ path, input }) => {
    const res = await fetch(`/trpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ json: input }),
    })
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
    const json = await res.json() as { result?: { data?: { json?: unknown } } }
    return json.result?.data?.json
  }, { path, input }) as T
}

async function appTrpcQuery<T>(page: Page, path: string, input?: unknown): Promise<T> {
  return await page.evaluate(async ({ path, input }) => {
    const url = new URL(`/trpc/${path}`, window.location.origin)
    url.searchParams.set('input', JSON.stringify({ json: input }))
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
    const json = await res.json() as { result?: { data?: { json?: unknown } } }
    return json.result?.data?.json
  }, { path, input }) as T
}

async function envTrpcMutation<T>(manifest: LaunchManifest, envToken: string, path: string, input?: unknown): Promise<T> {
  const res = await fetch(`${serverUrl(manifest, 'env')}/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${envToken}` },
    body: JSON.stringify({ json: input }),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  const json = await res.json() as { result?: { data?: { json?: unknown } } }
  return json.result?.data?.json as T
}

async function openFirstFolderChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Open a shell, file, or browser pane/ }).click()
  await page.getByRole('button', { name: 'File System' }).click()
  const createChatButton = page.getByRole('button', { name: /Open project|Create chat|create chat/i }).first()
  await expect(createChatButton).toBeVisible({ timeout: 30_000 })
  await createChatButton.click()
}
