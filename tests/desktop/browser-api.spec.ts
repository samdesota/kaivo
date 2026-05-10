import http from 'node:http'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'
import { parseDesktopLogFile } from './harness/logs'

const vitePort = 5193
const chromeUrl = `http://127.0.0.1:${vitePort}/login`
const tabUrl = `http://127.0.0.1:${vitePort}/browser-api-tab.html`

test('browser API creates and navigates a webframe tab from the chrome page', async ({ desktopLogPath, desktopStateDir }, testInfo) => {
  const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: path.resolve('.'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const viteLogs: string[] = []
  vite.stdout?.on('data', (chunk) => viteLogs.push(String(chunk)))
  vite.stderr?.on('data', (chunk) => viteLogs.push(String(chunk)))

  try {
    await waitForHttp(chromeUrl)
    const app = await electron.launch({
      args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/cloud-code-desktop/dist/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'desktop-browser-api-test',
        CC_DESKTOP_CHROME_URL: chromeUrl,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
      },
    })

    try {
      const page = await app.firstWindow()
      await expect(page.getByLabel('Password')).toBeVisible({ timeout: 15_000 })
      const browserTabId = await page.evaluate(async (url) => {
        const mod = await (0, eval)('import("/src/lib/browser-api.ts")')
        const api = mod.createBrowserApi(window)
        await api.setSlot({ paneId: 'pane-a', rect: { x: 20, y: 80, width: 640, height: 360 } })
        const tab = await api.createTab({ paneId: 'pane-a', url })
        await api.navigate({ browserTabId: tab.browserTabId, url })
        return tab.browserTabId
      }, tabUrl)

      await expect.poll(async () => {
        const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        return state.tabRecords.some((tab) => tab.id === browserTabId)
      }).toBe(true)

      const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
      expect(state.windowInfo[0]?.slots).toContainEqual(
        expect.objectContaining({ name: 'browser-pane:pane-a' }),
      )

      await expect.poll(() =>
        parseDesktopLogFile(desktopLogPath).some(
          (record) => record.kind === 'tab-renderer' && record.msg.includes('browser api tab ready'),
        ),
      ).toBe(true)
    } finally {
      await app.close().catch(() => undefined)
    }
  } catch (error) {
    await testInfo.attach('vite-log-tail', {
      body: viteLogs.slice(-40).join(''),
      contentType: 'text/plain',
    })
    throw error
  } finally {
    await stopProcess(vite)
  }
})

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await canGet(url)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function canGet(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve((res.statusCode ?? 500) < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

declare global {
  var cloudCodeDesktopTest: {
    getState: () => Promise<{
      config: { chromeUrl: string }
      windowIds: string[]
      browserAgentSocketPath?: string
      tabRecords: Array<{ id: string; url: string }>
      windowInfo: Array<{ slots: Array<{ name: string }> }>
      nativeViews: Array<{ children: Array<{ bounds?: { x: number; y: number; width: number; height: number } }> }>
    }>
  }
}
