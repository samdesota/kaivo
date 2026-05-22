import path from 'node:path'
import { defineConfig } from '@playwright/test'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100'
const DATA_DIR = path.resolve(process.cwd(), process.env.PLAYWRIGHT_DATA_DIR ?? 'test-data')

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    // We rely on `npm run build` having been run already in CI; locally the
    // `npm run test:e2e:full` script in README rebuilds first.
    command: 'node dist/server/index.js',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      APP_SQLITE_PATH: path.join(DATA_DIR, 'app.db'),
      CC_INSTANCE_ID: 'playwright-web',
      PORT: new URL(BASE_URL).port,
      DATA_DIR,
      ADMIN_PASSWORD_BOOTSTRAP: 'e2e-password-123',
      CC_SERVICE_CREDENTIAL: 'playwright-service-credential',
      COOKIE_SECURE: 'false',
    },
  },
})
