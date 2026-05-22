import http from 'node:http'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'

const vitePort = 5194
const chromeUrl = `http://127.0.0.1:${vitePort}/login`
const tabUrl = `http://127.0.0.1:${vitePort}/browser-api-tab.html`

test('workspace archive closes native browser tabs without removing persisted tab records', async ({ desktopLogPath, desktopStateDir }, testInfo) => {
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
      args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/kaivo-desktop/dist/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'desktop-workspace-archive-browser-tabs-test',
        CC_DESKTOP_CHROME_URL: chromeUrl,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
      },
    })

    try {
      const page = await app.firstWindow()
      await expect(page.getByLabel('Password')).toBeVisible({ timeout: 15_000 })
      const result = await page.evaluate(async (url) => {
        const browserMod = await (0, eval)('import("/src/lib/browser-api.ts")')
        const cleanupMod = await (0, eval)('import("/src/routes/workspace/browser-tab-cleanup.ts")')
        const api = browserMod.createBrowserApi(window)
        await api.setSlot({ paneId: 'workspace-browser-tab', rect: { x: 20, y: 80, width: 640, height: 360 } })
        const nativeTab = await api.createTab({ paneId: 'workspace-browser-tab', url })
        const persistedTabs = [
          {
            id: 'workspace-tab-1',
            type: 'browser',
            url,
            browserTabId: nativeTab.browserTabId,
            title: 'Browser tab',
          },
        ]
        await cleanupMod.closeNativeBrowserTabsForWorkspace(persistedTabs)
        return { browserTabId: nativeTab.browserTabId, persistedTabs }
      }, tabUrl)

      await expect.poll(async () => {
        const state = await app.evaluate(() => {
          const testApi = globalThis.cloudCodeDesktopTest as unknown as {
            getState: () => Promise<{ tabRecords: Array<{ id: string; url: string }> }>
          }
          return testApi.getState()
        })
        return state.tabRecords.some((tab) => tab.id === result.browserTabId)
      }).toBe(false)
      expect(result.persistedTabs).toEqual([
        expect.objectContaining({
          id: 'workspace-tab-1',
          type: 'browser',
          browserTabId: result.browserTabId,
        }),
      ])
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
