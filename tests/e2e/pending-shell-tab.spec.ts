import http from 'node:http'
import { expect, test, type Page } from '@playwright/test'

test('New shell opens a pending workspace tab immediately before shell creation finishes', async ({ page }) => {
  const env = await startMockEnvServer()
  try {
    await login(page)
    const workspace = await trpcMutation<{ id: string; name: string }>(page, 'workspace.create', { name: `Pending Shell ${Date.now()}` })
    await trpcMutation(page, 'env.registerLocal', {
      url: env.url,
      envToken: 'pending-shell-token-123',
      label: 'Pending shell env',
      localIdentityLabel: 'playwright',
    })

    await page.goto(`/w/${workspace.id}`)
    await waitForAppDataReady(page)

    await page.getByRole('button', { name: /Open a shell, file, or browser pane/ }).click()
    await page.getByLabel('Universal menu search').fill('new shell')
    await page.keyboard.press('Enter')

    await expect(page.getByRole('tab', { name: 'Starting shell…' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Starting shell…').last()).toBeVisible()
    await expect.poll(() => env.createStarted).toBe(true)

    env.finishCreate()
    await expect(page.getByRole('tab', { name: /shell 12345678/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Starting shell…' })).toHaveCount(0)
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
  createStarted: boolean
  finishCreate: () => void
  close: () => Promise<void>
}> {
  let createdShellId: string | null = null
  let finishCreate: (() => void) | null = null
  let createStarted = false
  const createReleased = new Promise<void>((resolve) => {
    finishCreate = resolve
  })

  const server = http.createServer(async (req, res) => {
    setCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url === '/healthz') {
      sendJson(res, { ok: true, kind: 'local', label: 'Pending shell env', paired: true })
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
        get createdShellId() { return createdShellId },
        set createdShellId(value) { createdShellId = value },
        markCreateStarted: () => { createStarted = true },
        waitForCreateRelease: () => createReleased,
      }))
    }
    sendJson(res, batch ? results : results[0])
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock env server did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    get createStarted() { return createStarted },
    finishCreate: () => finishCreate?.(),
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function handleEnvProcedure(
  procedure: string,
  state: {
    createdShellId: string | null
    markCreateStarted: () => void
    waitForCreateRelease: () => Promise<void>
  } & { createdShellId: string | null },
) {
  if (procedure === 'shell.create') {
    state.markCreateStarted()
    await state.waitForCreateRelease()
    state.createdShellId = 'shell-e2e-12345678'
    return trpcResult({ id: state.createdShellId })
  }
  if (procedure === 'shell.list') {
    return trpcResult(state.createdShellId
      ? [{ id: state.createdShellId, alive: true, cols: 80, rows: 24, cwd: '/tmp', title: null }]
      : [])
  }
  if (procedure === 'agent.sessionList') return trpcResult([])
  if (procedure === 'fs.browseHome') return trpcResult({ path: '/tmp', home: '/tmp', defaultPath: '/tmp', entries: [] })
  if (procedure === 'repo.listRecentFolders') return trpcResult([])
  if (procedure === 'repo.listConfigs') return trpcResult([])
  if (procedure === 'repo.listWorktrees') return trpcResult([])
  if (procedure === 'fs.searchGitTrackedFiles') return trpcResult([])
  if (procedure === 'shell.resize') return trpcResult({ ok: true })
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
