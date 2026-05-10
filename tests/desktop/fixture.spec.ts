import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  test,
  expect,
  launchDesktopFixture,
  assertNoUnhandledDesktopErrors,
  findChromeFixturePage,
} from './harness/electron-fixture'
import { parseDesktopLogFile } from './harness/logs'

declare global {
  interface Window {
    fixture: {
      getState: () => Promise<{
        windowIds: number[]
        webframeAppState: { status: string }
        tabRecords: Array<{ id: string; url: string; title: string }>
        slotBounds: Record<string, { x: number; y: number; width: number; height: number }>
        activeTabIds: string[]
        logPath: string
        stateDir: string
      }>
      emitUnhandled: () => Promise<void>
    }
  }
}

test('fixture Electron launch exposes page control, main inspection, and logs', async ({ chromePage, desktopApp, desktopLogPath }) => {
  await expect(chromePage.locator('h1')).toHaveText('Desktop Fixture')
  await chromePage.locator('#ping').click()

  const rendererValue = await chromePage.evaluate(() => document.title || document.querySelector('h1')?.textContent)
  expect(rendererValue).toBe('Desktop Fixture')

  const mainWindowIds = await desktopApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.id),
  )
  expect(mainWindowIds.length).toBeGreaterThanOrEqual(2)

  const fixtureState = await chromePage.evaluate(() => window.fixture.getState())
  expect(fixtureState.windowIds.length).toBeGreaterThanOrEqual(2)
  expect(fixtureState.webframeAppState.status).toBe('fixture')
  expect(fixtureState.tabRecords).toContainEqual(
    expect.objectContaining({ id: 'fixture-tab' }),
  )
  expect(fixtureState.slotBounds['fixture-slot']).toMatchObject({ width: 300, height: 200 })
  expect(fixtureState.activeTabIds).toContain('fixture-tab')
  expect(fixtureState.logPath).toBe(desktopLogPath)

  await expect.poll(() => parseDesktopLogFile(desktopLogPath).length).toBeGreaterThan(0)
  const records = parseDesktopLogFile(desktopLogPath)
  expect(records.some((record) => record.kind === 'main')).toBe(true)
  expect(records.some((record) => record.kind === 'chrome-renderer')).toBe(true)
  expect(records.some((record) => record.kind === 'tab-renderer')).toBe(true)
})

test('harness fails when an unhandled error is emitted', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-code-desktop-unhandled-'))
  const logPath = path.join(stateDir, 'desktop.log')
  const app = await launchDesktopFixture({ desktopLogPath: logPath, desktopStateDir: stateDir })
  try {
    const page = await findChromeFixturePage(app)
    await page.evaluate(() => window.fixture.emitUnhandled())
    await expect.poll(() => parseDesktopLogFile(logPath).some((record) => record.kind === 'exception')).toBe(true)
    expect(() => assertNoUnhandledDesktopErrors(logPath)).toThrow(/Desktop harness captured/)
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
