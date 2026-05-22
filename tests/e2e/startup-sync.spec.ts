import { expect, test } from '@playwright/test'

test.setTimeout(10_000)
const fastExpect = expect.configure({ timeout: 1_500 })

test('workspace route renders with app data provider mounted', async ({ page }) => {
  const workspaceName = `Startup Sync Workspace ${Date.now()}`
  await page.goto('/login')
  await page.getByLabel('Password').fill('e2e-password-123')
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/trpc/auth.login') && response.ok()),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ])
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 3_000 }).catch(() => undefined)

  const response = await page.context().request.post('/trpc/workspace.create', {
    data: { json: { name: workspaceName } },
  })
  if (!response.ok()) throw new Error(`workspace.create failed: ${response.status()} ${await response.text()}`)
  const body = await response.json() as { result?: { data?: { json?: { id?: string } } } }
  const workspaceId = body.result?.data?.json?.id
  fastExpect(workspaceId).toBeTruthy()

  await page.goto(`/w/${workspaceId}`, { waitUntil: 'domcontentloaded', timeout: 3_000 })
  await fastExpect.poll(() => page.evaluate(() => Boolean((window as unknown as { __kaivoAppDataProviderMounted?: boolean }).__kaivoAppDataProviderMounted))).toBe(true)
  await fastExpect.poll(() => page.evaluate(() => Boolean((window as unknown as { __kaivoAppDataReady?: boolean }).__kaivoAppDataReady))).toBe(true)
  await fastExpect(page.getByTitle(workspaceName).first()).toBeVisible()
})
