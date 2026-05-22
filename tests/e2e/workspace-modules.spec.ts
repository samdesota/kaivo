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

test('creates and renames a workspace from the tab bar without a workspace list refetch', async ({ page }) => {
  await login(page)
  const initial = await createWorkspaceViaFetch(page, `Tab Bar Seed ${Date.now()}`)
  await page.goto(`/w/${initial.id}`)
  await waitForAppDataReady(page)

  const calls = recordWorkspaceMetadataCalls(page)
  await page.getByRole('button', { name: 'Create new workspace from tab bar' }).click()
  const renamed = `Tab Bar Renamed ${Date.now()}`
  const input = page.getByLabel('Workspace name').last()
  await expect(input).toBeVisible()
  await input.fill(renamed)
  await input.press('Enter')

  await expect(page.getByRole('link', { name: renamed }).first()).toBeVisible()
  await page.getByRole('link', { name: initial.name }).first().click()
  await page.getByRole('link', { name: renamed }).first().click()
  await expect(page.getByRole('link', { name: renamed }).first()).toBeVisible()

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
  const denied = ['workspace.listTree', 'workspace.list', 'workspace.get']
  const calls: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    for (const procedure of denied) {
      if (new RegExp(`/trpc/${procedure.replace('.', '\\.')}(?:[?,/]|$)`).test(url)) calls.push(procedure)
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
