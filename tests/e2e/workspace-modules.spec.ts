import { expect, test, type Page } from '@playwright/test'

test('switching existing workspaces does not refetch migrated workspace metadata after startup sync is ready', async ({ page }) => {
  await login(page)
  const first = await createWorkspaceViaFetch(page, `Switch Local A ${Date.now()}`)
  const second = await createWorkspaceViaFetch(page, `Switch Local B ${Date.now()}`)

  await page.goto(`/w/${first.id}`)
  await waitForAppDataReady(page)
  await expect(page.getByRole('link', { name: second.name }).first()).toBeVisible()

  const calls = recordWorkspaceMetadataCalls(page)
  await page.getByRole('link', { name: second.name }).first().click()
  await expect(page).toHaveURL(new RegExp(`/w/${second.id}`))
  await page.waitForTimeout(250)

  expect(calls).toEqual([])
})

test('renames a workspace from the sidebar without a workspace list refetch', async ({ page }) => {
  await login(page)
  const initial = await createWorkspaceViaFetch(page, `Tab Bar Seed ${Date.now()}`)
  const other = await createWorkspaceViaFetch(page, `Sidebar Other ${Date.now()}`)
  await page.goto(`/w/${initial.id}`)
  await waitForAppDataReady(page)

  const calls = recordWorkspaceMetadataCalls(page)
  const sidebar = page.getByRole('complementary', { name: 'Workspaces' })
  await sidebar.getByRole('link', { name: initial.name, exact: true }).dblclick()
  const renamed = `Sidebar Renamed ${Date.now()}`
  const input = page.getByLabel('Workspace name').last()
  await expect(input).toBeVisible()
  await input.fill(renamed)
  await input.press('Enter')

  await expect(sidebar.getByRole('link', { name: renamed, exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: other.name, exact: true }).click()
  await sidebar.getByRole('link', { name: renamed, exact: true }).click()
  await expect(sidebar.getByRole('link', { name: renamed, exact: true })).toBeVisible()

  expect(calls.filter((call) => call.endsWith('workspace.list'))).toEqual([])
})

test('derives folder tree locally after folder create, move, collapse, expand, and reload', async ({ page }) => {
  await login(page)
  const workspace = await createWorkspaceViaFetch(page, `Folder Workspace ${Date.now()}`)
  await page.goto(`/w/${workspace.id}`)
  await waitForAppDataReady(page)

  const folderName = `Folder ${Date.now()}`
  const folder = await trpcMutation<{ id: string }>(page, 'workspace.createFolder', { name: folderName, parentId: null })
  const folderId = folder.id
  await trpcMutation(page, 'workspace.moveSidebarNode', {
    nodeType: 'workspace',
    nodeId: workspace.id,
    parentFolderId: folderId,
    beforeNodeId: null,
  })
  await trpcMutation(page, 'workspace.setFolderCollapsed', { id: folderId, collapsed: true })
  await page.reload()
  await waitForAppDataReady(page)

  const expandFolder = page.getByRole('button', { name: `Expand folder ${folderName}`, exact: true })
  await expect(expandFolder).toBeVisible()
  const sidebar = page.getByRole('complementary', { name: 'Workspaces' })
  await expect(sidebar.getByRole('link', { name: workspace.name })).toBeHidden()
  await expandFolder.click()
  await expect(sidebar.getByRole('link', { name: workspace.name })).toBeVisible()
})

test('restores workspace pane tabs and active tab across workspace switches without route-level tab fetches', async ({ page }) => {
  await login(page)
  const first = await createWorkspaceViaFetch(page, `Pane Tabs A ${Date.now()}`)
  const second = await createWorkspaceViaFetch(page, `Pane Tabs B ${Date.now()}`)
  await createPaneTabs(page, first.id)
  await trpcMutation(page, 'workspace.saveViewState', { workspaceId: first.id, state: { activeWorkspaceTabId: 'browser-tab' } })

  await page.goto(`/w/${first.id}`)
  await waitForAppDataReady(page)
  await expect(page.getByRole('tab', { name: /Shell Tab/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /Browser Tab/ })).toHaveAttribute('aria-selected', 'true')

  const calls = recordWorkspacePaneMetadataCalls(page)
  await page.getByRole('link', { name: second.name }).first().click()
  await expect(page).toHaveURL(new RegExp(`/w/${second.id}`))
  await page.getByRole('link', { name: first.name }).first().click()
  await expect(page).toHaveURL(new RegExp(`/w/${first.id}`))

  await expect(page.getByRole('tab', { name: /File Tab/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /Browser Tab/ })).toHaveAttribute('aria-selected', 'true')
  expect(calls.filter((call) => call === 'workspace.listTabs')).toEqual([])
})

test('closes workspace pane tabs with active fallback and persists server-side reorder after reload', async ({ page }) => {
  await login(page)
  const workspace = await createWorkspaceViaFetch(page, `Pane Close ${Date.now()}`)
  await createPaneTabs(page, workspace.id)
  await trpcMutation(page, 'workspace.upsertTab', { workspaceId: workspace.id, tab: browserTab('browser-tab', 'Browser Tab', 'https://browser.example'), position: 2 })
  await trpcMutation(page, 'workspace.upsertTab', { workspaceId: workspace.id, tab: browserTab('second-browser-tab', 'Second Browser Tab', 'https://second.example'), position: 0 })
  await trpcMutation(page, 'workspace.saveViewState', { workspaceId: workspace.id, state: { activeWorkspaceTabId: 'browser-tab' } })

  await page.goto(`/w/${workspace.id}`)
  await waitForAppDataReady(page)
  await expect(page.getByRole('tab').nth(0)).toContainText('Second Browser Tab')

  await page.getByRole('tab').nth(3).getByRole('button', { name: 'Close tab' }).click()
  await expect(page.getByRole('tab', { name: /File Tab/ })).toHaveAttribute('aria-selected', 'true')
  await page.goto(`/w/${workspace.id}`)
  await waitForAppDataReady(page)

  await expect(page.getByRole('tab').filter({ hasText: /^Browser Tab/ })).toHaveCount(0)
  await expect(page.getByRole('tab').nth(0)).toContainText('Second Browser Tab')
  await expect(page.getByRole('tab', { name: /File Tab/ })).toHaveAttribute('aria-selected', 'true')
})

test('keeps collapsed agent pane state per workspace across switches', async ({ page }) => {
  await login(page)
  const first = await createWorkspaceViaFetch(page, `View State A ${Date.now()}`)
  const second = await createWorkspaceViaFetch(page, `View State B ${Date.now()}`)

  await page.goto(`/w/${first.id}`)
  await waitForAppDataReady(page)
  await page.getByTitle('Collapse agent chat (⌘I)').click()
  await expect(page.getByTitle('Expand agent chat (⌘I)')).toBeVisible()

  await page.getByRole('link', { name: second.name, exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`/w/${second.id}`))
  await expect(page.getByTitle('Collapse agent chat (⌘I)')).toBeVisible()
  await page.getByRole('link', { name: first.name, exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`/w/${first.id}`))
  await expect(page.getByTitle('Expand agent chat (⌘I)')).toBeVisible()
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

function recordWorkspaceMetadataCalls(page: Page): string[] {
  const denied = ['workspace.listTree', 'workspace.list', 'workspace.get', 'workspace.listAgentTabs']
  const calls: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    for (const procedure of denied) {
      if (new RegExp(`/trpc/${procedure.replace('.', '\\.')}(?:[?,/]|$)`).test(url)) calls.push(procedure)
    }
  })
  return calls
}

function recordWorkspacePaneMetadataCalls(page: Page): string[] {
  const denied = ['workspace.getViewState', 'workspace.listTabs']
  const calls: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    for (const procedure of denied) {
      if (new RegExp(`/trpc/${procedure.replace('.', '\.')}(?:[?,/]|$)`).test(url)) calls.push(procedure)
    }
  })
  return calls
}

async function createWorkspaceViaFetch(page: Page, name: string): Promise<{ id: string; name: string }> {
  return await trpcMutation(page, 'workspace.create', { name })
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

async function createPaneTabs(page: Page, workspaceId: string) {
  await trpcMutation(page, 'workspace.upsertTab', { workspaceId, tab: { id: 'shell-tab', type: 'shell', envId: 'local', shellId: 'shell-1', title: 'Shell Tab', titleSource: 'explicit' }, position: 0 })
  await trpcMutation(page, 'workspace.upsertTab', { workspaceId, tab: { id: 'file-tab', type: 'file', envId: 'local', path: '/tmp/example.txt', title: 'File Tab' }, position: 1 })
  await trpcMutation(page, 'workspace.upsertTab', { workspaceId, tab: browserTab('browser-tab', 'Browser Tab', 'https://browser.example'), position: 2 })
}

function browserTab(id: string, title: string, url: string) {
  return { id, type: 'browser' as const, url, title }
}
