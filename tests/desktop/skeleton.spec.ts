import path from 'node:path'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'
import { parseDesktopLogFile } from './harness/logs'

test('desktop harness launches the built skeleton app and captures logs', async ({ desktopLogPath, desktopStateDir }) => {
  const app = await electron.launch({
    args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/cloud-code-desktop/dist/main.js')],
    env: {
      ...process.env,
      CC_INSTANCE_ID: 'desktop-skeleton-test',
      CC_DESKTOP_CHROME_URL: 'data:text/html,<h1>Cloud Code Desktop Skeleton</h1><script>console.log("desktop skeleton renderer ready")</script>',
      CC_DESKTOP_TEST_LOG: desktopLogPath,
      CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
    },
  })

  try {
    const page = await app.firstWindow()
    await expect(page).toHaveURL(/data:text\/html/)
    await expect.poll(() => parseDesktopLogFile(desktopLogPath).length).toBeGreaterThan(0)

    const records = parseDesktopLogFile(desktopLogPath)
    expect(records.some((record) => record.kind === 'main')).toBe(true)
    expect(records.some((record) => record.kind === 'chrome-renderer')).toBe(true)
  } finally {
    await app.close().catch(() => undefined)
  }
})
