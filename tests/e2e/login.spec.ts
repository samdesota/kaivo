import { test, expect } from '@playwright/test'

// Relies on `ADMIN_PASSWORD_BOOTSTRAP=e2e-password-123` in playwright.config.ts.
// If the admin row already exists in the DB from a previous run, the seeded
// password wins; the test DB should be reset between runs.

test('logged-out user is redirected to /login and can sign in', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel('Password').fill('e2e-password-123')
  await page.getByRole('button', { name: /sign in/i }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: /cloud coding environment/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible()
})

test('wrong password shows an error and stays on /login', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Password').fill('definitely-not-the-password')
  await page.getByRole('button', { name: /sign in/i }).click()

  await expect(page.getByText(/invalid credentials/i)).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})
