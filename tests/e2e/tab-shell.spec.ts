import { test, expect, type Page } from '@playwright/test'

// Phase 1 smoke — sandbox tab shell.
// Logs in, creates a real sandbox, then exercises shell tabs to prove that
// shell lifecycle is independent of tab lifecycle (the headline Phase 1
// acceptance criterion).
//
// Requires a Docker daemon reachable from the app server — the webServer
// launched by playwright.config.ts runs on the host and invokes `docker
// create`. In CI the e2e job builds `cloud-code-sandbox:dev` before the
// Playwright run.
//
// `SANDBOX_E2E_SKIP=1` lets contributors skip the sandbox-creating tests on
// environments without a usable Docker setup.

const shouldSkip = !!process.env.SANDBOX_E2E_SKIP

test.describe('sandbox tab shell', () => {
  test.skip(shouldSkip, 'SANDBOX_E2E_SKIP set')

  test.describe.configure({ mode: 'serial' })

  let sandboxName: string
  let sandboxId: string

  async function login(page: Page) {
    await page.goto('/login')
    await page.getByLabel('Password').fill('e2e-password-123')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/$/)
  }

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await login(page)
      sandboxName = `e2e-${Date.now().toString(36)}`
      await page.getByPlaceholder('e.g. experiments').fill(sandboxName)
      await page.getByRole('button', { name: /^create$/i }).click()

      const sandboxLink = page.getByRole('link', { name: sandboxName }).first()
      await sandboxLink.waitFor({ state: 'visible', timeout: 30_000 })
      const href = await sandboxLink.getAttribute('href')
      const match = href?.match(/\/sandbox\/([^/]+)/)
      if (!match) throw new Error(`could not resolve sandbox id from ${href}`)
      sandboxId = match[1]!
    } finally {
      await context.close()
    }
  })

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await login(page)
      page.on('dialog', (d) => void d.accept())
      // Archive then delete so the container and workspace are removed.
      const row = page.locator('li', { hasText: sandboxName })
      await row.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined)
      const archive = row.getByRole('button', { name: 'Archive' })
      if (await archive.isVisible().catch(() => false)) {
        await archive.click()
      }
      const del = row.getByRole('button', { name: 'Delete' })
      await del.click().catch(() => undefined)
    } finally {
      await context.close()
    }
  })

  test('shell lifecycle is independent of tabs', async ({ page }) => {
    await login(page)
    await page.goto(`/sandbox/${sandboxId}`)

    // Wait for the sandbox to be "(running)" before creating a shell.
    await expect(page.locator('header').first()).toContainText(/\(running\)/, { timeout: 60_000 })

    // The right pane starts with a single newtab.
    const tabList = page.getByRole('tablist').first()
    await expect(tabList).toBeVisible()

    // Quick action: + New shell.
    await page.getByRole('button', { name: /\+ new shell/i }).click()

    // A shell tab should appear in the tab bar.
    const shellTab = tabList.getByRole('tab').filter({ hasText: /^shell / }).first()
    await expect(shellTab).toBeVisible({ timeout: 15_000 })

    // Shells dropdown should count 1.
    const shellsButton = page.getByRole('button', { name: /^Shells/ })
    await expect(shellsButton).toContainText('1')

    // The xterm should render inside the tab (canvas element via @xterm/xterm).
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 10_000 })

    // Close the shell tab.
    await shellTab.getByRole('button', { name: /close tab/i }).click()

    // Tab is gone...
    await expect(tabList.getByRole('tab').filter({ hasText: /^shell / })).toHaveCount(0)
    // ...but the shell still lives.
    await expect(shellsButton).toContainText('1')

    // Reopen it from the Shells dropdown.
    await shellsButton.click()
    await page.getByRole('menu').getByRole('button', { name: /^open$/i }).first().click()

    // Shell tab returns and xterm mounts again.
    await expect(tabList.getByRole('tab').filter({ hasText: /^shell / })).toHaveCount(1)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 10_000 })
  })

  test('tab state persists across reload', async ({ page }) => {
    await login(page)
    await page.goto(`/sandbox/${sandboxId}`)
    await expect(page.locator('header').first()).toContainText(/\(running\)/, { timeout: 60_000 })

    const tabList = page.getByRole('tablist').first()
    await expect(tabList).toBeVisible()

    // Open a fresh shell so this test doesn't depend on prior test state.
    await page.getByRole('button', { name: /\+ new shell/i }).click()
    await expect(tabList.getByRole('tab').filter({ hasText: /^shell / })).toHaveCount(1, {
      timeout: 15_000,
    })

    await page.reload()

    // The shell tab is restored from localStorage.
    await expect(tabList.getByRole('tab').filter({ hasText: /^shell / })).toHaveCount(1, {
      timeout: 10_000,
    })
  })
})
