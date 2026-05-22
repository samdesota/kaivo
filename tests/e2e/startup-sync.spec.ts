import { expect, test } from '@playwright/test'

test('workspace route renders with app data provider mounted', async ({ page }) => {
  const workspaceName = `Startup Sync Workspace ${Date.now()}`
  await page.goto('/login')
  await page.getByLabel('Password').fill('e2e-password-123')
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/trpc/auth.login') && response.ok()),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ])
  await page.goto('/')

  const body = await page.evaluate(async (name) => {
    const res = await fetch('/trpc/workspace.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ json: { name } }),
    })
    if (!res.ok) throw new Error(`workspace.create failed: ${res.status} ${await res.text()}`)
    return await res.json() as { result?: { data?: { json?: { id?: string } } } }
  }, workspaceName)
  const workspaceId = body.result?.data?.json?.id
  expect(workspaceId).toBeTruthy()

  await page.goto(`/w/${workspaceId}`)
  await expect(page.getByRole('link', { name: workspaceName, exact: true }).first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __kaivoAppDataProviderMounted?: boolean }).__kaivoAppDataProviderMounted))).toBe(true)
})
