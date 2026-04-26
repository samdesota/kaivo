import { test, expect, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD ?? 'workspace-test-password')
  await page.getByRole('button', { name: /sign in/i }).click()
}

test('workspace landing shows bottom bar and can create another workspace', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await login(page)
  await expect(page).toHaveURL(/\/w\/[A-Z0-9]+/i, { timeout: 15_000 })

  const bar = page.getByText('Workspaces').locator('..')
  await expect(bar).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create new workspace' })).toBeVisible()

  const beforeUrl = page.url()
  await page.getByRole('button', { name: 'Create new workspace' }).click()
  const input = page.getByLabel('Workspace name')
  await expect(input).toBeFocused({ timeout: 10_000 })
  await expect(page).not.toHaveURL(beforeUrl)

  const workspaceName = `E2E workspace ${Date.now()}`
  await input.fill(workspaceName)
  await input.press('Enter')
  await expect(page.getByRole('link', { name: workspaceName })).toBeVisible()
  expect(consoleErrors).toEqual([])
})

test('opening a shell from command palette keeps the workspace tab open', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await login(page)
  await expect(page).toHaveURL(/\/w\/[A-Z0-9]+/i, { timeout: 15_000 })

  await page.getByRole('button', { name: '⌘K' }).click()
  await expect(page.getByPlaceholder('Search shells, previews, actions…')).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('region', { name: 'Workspace Tabs' })).toBeVisible({ timeout: 10_000 })
  const activeShellTab = page.getByRole('tab', { selected: true }).filter({ hasText: /shell/i })
  await expect(activeShellTab).toBeVisible()
  const shellStatus = page.getByText(/running|stopped|terminated/).first()
  await expect(shellStatus).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1_000)
  await expect(activeShellTab).toBeVisible()
  await expect(shellStatus).toBeVisible()
  expect(consoleErrors).toEqual([])
})
