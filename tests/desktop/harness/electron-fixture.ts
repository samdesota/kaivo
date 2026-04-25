import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { hasUnhandledDesktopError, parseDesktopLogFile, recentDesktopLogLines } from './logs'

type DesktopFixtures = {
  desktopApp: ElectronApplication
  chromePage: Page
  desktopLogPath: string
  desktopStateDir: string
}

export const test = base.extend<DesktopFixtures>({
  desktopStateDir: async ({}, use) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-code-desktop-state-'))
    try {
      await use(stateDir)
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
  },

  desktopLogPath: async ({ desktopStateDir }, use) => {
    await use(path.join(desktopStateDir, 'desktop.log'))
  },

  desktopApp: async ({ desktopLogPath, desktopStateDir }, use, testInfo) => {
    const app = await launchDesktopFixture({ desktopLogPath, desktopStateDir })
    try {
      await use(app)
      assertNoUnhandledDesktopErrors(desktopLogPath)
    } catch (error) {
      const recent = recentDesktopLogLines(desktopLogPath).join('\n')
      if (recent) {
        await testInfo.attach('desktop-log-tail', { body: recent, contentType: 'text/plain' })
      }
      throw error
    } finally {
      await app.close().catch(() => undefined)
    }
  },

  chromePage: async ({ desktopApp, desktopLogPath }, use) => {
    const page = await findChromeFixturePage(desktopApp)
    page.on('console', (msg) => appendDesktopHarnessLog(desktopLogPath, 'chrome-renderer', msg.type() === 'error' ? 'error' : 'info', msg.text()))
    await use(page)
  },
})

export { expect }

export async function launchDesktopFixture(opts: {
  desktopLogPath: string
  desktopStateDir: string
}): Promise<ElectronApplication> {
  return electron.launch({
    args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'tests/desktop/fixture/main.cjs')],
    env: {
      ...process.env,
      CC_DESKTOP_TEST_LOG: opts.desktopLogPath,
      CC_DESKTOP_TEST_STATE_DIR: opts.desktopStateDir,
    },
  })
}

export function assertNoUnhandledDesktopErrors(logPath: string): void {
  const records = parseDesktopLogFile(logPath)
  if (!hasUnhandledDesktopError(records)) return
  const recent = recentDesktopLogLines(logPath).join('\n')
  throw new Error(`Desktop harness captured an unhandled error or crash. Log: ${logPath}\n${recent}`)
}

export async function findChromeFixturePage(app: ElectronApplication): Promise<Page> {
  await app.firstWindow()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const page of app.windows()) {
      if (await page.locator('h1').filter({ hasText: 'Desktop Fixture' }).isVisible().catch(() => false)) {
        return page
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Fixture chrome page did not load')
}

function appendDesktopHarnessLog(
  logPath: string,
  kind: 'chrome-renderer' | 'tab-renderer',
  level: 'info' | 'error',
  msg: string,
): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), kind, level, msg })}\n`)
}
