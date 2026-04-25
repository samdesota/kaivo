import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/desktop',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
})
