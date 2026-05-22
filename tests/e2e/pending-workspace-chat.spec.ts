import http from 'node:http'
import { expect, test, type Page } from '@playwright/test'

test('creating a workspace chat shows a loading state immediately before the session exists', async ({ page }) => {
  const env = await startMockEnvServer()
  try {
    await login(page)
    const workspace = await trpcMutation<{ id: string; name: string }>(page, 'workspace.create', { name: `Pending Chat ${Date.now()}` })
    await trpcMutation(page, 'env.registerLocal', {
      url: env.url,
      envToken: 'pending-chat-token-123',
      label: 'Pending chat env',
      localIdentityLabel: 'playwright',
    })

    await page.goto(`/w/${workspace.id}`)
    await waitForAppDataReady(page)

    await page.getByRole('button', { name: /Open a shell, file, or browser pane/ }).click()
    await page.getByRole('button', { name: 'File System' }).click()
    await page.getByRole('button', { name: 'Open project project' }).click()

    await expect(page.getByText('Creating chat…')).toBeVisible()
    await expect.poll(() => env.startChatStarted).toBe(true)

    env.finishStartChat()
    await expect(page.getByRole('tab', { name: 'Pending Chat Session' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Creating chat…')).toHaveCount(0)
  } finally {
    await env.close()
  }
})

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

async function startMockEnvServer(): Promise<{
  url: string
  startChatStarted: boolean
  finishStartChat: () => void
  close: () => Promise<void>
}> {
  let createdSession = false
  let startChatStarted = false
  let finishStartChat: (() => void) | null = null
  const startReleased = new Promise<void>((resolve) => {
    finishStartChat = resolve
  })

  const server = http.createServer(async (req, res) => {
    setCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url === '/healthz') {
      sendJson(res, { ok: true, kind: 'local', label: 'Pending chat env', paired: true })
      return
    }
    const requestUrl = req.url ?? ''
    if (!requestUrl.startsWith('/trpc/')) {
      res.writeHead(404)
      res.end()
      return
    }

    const procedures = decodeURIComponent(requestUrl.slice('/trpc/'.length).split('?')[0] ?? '').split(',')
    const batch = new URL(requestUrl, 'http://127.0.0.1').searchParams.get('batch') === '1'
    const results = []
    for (const procedure of procedures) {
      results.push(await handleEnvProcedure(procedure, {
        get createdSession() { return createdSession },
        set createdSession(value) { createdSession = value },
        markStartChatStarted: () => { startChatStarted = true },
        waitForStartRelease: () => startReleased,
      }))
    }
    sendJson(res, batch ? results : results[0])
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock env server did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    get startChatStarted() { return startChatStarted },
    finishStartChat: () => finishStartChat?.(),
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function handleEnvProcedure(
  procedure: string,
  state: {
    createdSession: boolean
    markStartChatStarted: () => void
    waitForStartRelease: () => Promise<void>
  },
) {
  if (procedure === 'agent.sessionStart') {
    state.markStartChatStarted()
    await state.waitForStartRelease()
    state.createdSession = true
    return trpcResult({ id: 'session-pending-chat' })
  }
  if (procedure === 'agent.sessionList') {
    return trpcResult(state.createdSession
      ? [{ id: 'session-pending-chat', title: 'Pending Chat Session', status: 'active', workspaceId: null, workingDir: '/tmp/project', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }]
      : [])
  }
  if (procedure === 'agent.agentStatus') return trpcResult({ hasProvider: true, ready: true })
  if (procedure === 'fs.browseHome') return trpcResult({ path: '/tmp', home: '/tmp', defaultPath: '/tmp', dirs: [{ name: 'project', path: '/tmp/project' }], files: [] })
  if (procedure === 'repo.listRecentFolders') return trpcResult([])
  if (procedure === 'repo.listConfigs') return trpcResult([])
  if (procedure === 'repo.listWorktrees') return trpcResult([])
  if (procedure === 'shell.list') return trpcResult([])
  if (procedure === 'agent.sessionMessages') return trpcResult([])
  if (procedure === 'agent.childTranscripts') return trpcResult([])
  if (procedure === 'agent.transcriptLatestSeq') return trpcResult({ seq: 0 })
  if (procedure === 'agent.sessionStatus') return trpcResult({ status: 'active' })
  return trpcResult(null)
}

function trpcResult(json: unknown) {
  return { result: { data: { json } } }
}

function setCors(res: http.ServerResponse) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization,content-type,trpc-accept')
}

function sendJson(res: http.ServerResponse, body: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
