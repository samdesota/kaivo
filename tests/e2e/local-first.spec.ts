import { expect, test } from '@playwright/test'

test('local SQLite app server exposes instance health without Docker or Postgres', async ({ request }) => {
  const health = await request.get('/healthz')

  expect(health.ok()).toBe(true)
  await expect(await health.json()).toEqual({ ok: true, instanceId: 'playwright-web' })
})

test('local SQLite app server has no fixed-port env registration by default', async ({ request }) => {
  const missing = await request.get('/internal/local-env/local-playwright-web')

  expect(missing.status()).toBe(404)
})
