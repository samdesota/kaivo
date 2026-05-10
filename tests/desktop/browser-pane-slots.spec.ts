import http from 'node:http'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'

const vitePort = 5194
const chromeUrl = `http://127.0.0.1:${vitePort}/login`
const tabUrlA = `http://127.0.0.1:${vitePort}/browser-api-tab.html?a`
const tabUrlB = `http://127.0.0.1:${vitePort}/browser-api-tab.html?b`

test('desktop harness verifies native browser tab slot bounds and active z-order', async ({ desktopLogPath, desktopStateDir }, testInfo) => {
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
      args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/zoottle-desktop/dist/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'desktop-browser-pane-slots-test',
        CC_DESKTOP_CHROME_URL: chromeUrl,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
      },
    })

    try {
      const page = await app.firstWindow()
      await expect(page.getByLabel('Password')).toBeVisible({ timeout: 15_000 })

      const ids = await page.evaluate(async ({ tabUrlA, tabUrlB }) => {
        const mod = await (0, eval)('import("/src/lib/browser-api.ts")')
        const api = mod.createBrowserApi(window)
        window.__browserApi = api
        await api.setSlot({ paneId: 'pane-a', rect: { x: 20, y: 80, width: 300, height: 220 } })
        await api.setSlot({ paneId: 'pane-b', rect: { x: 340, y: 80, width: 360, height: 220 } })
        const a = await api.createTab({ paneId: 'pane-a', url: tabUrlA })
        const b = await api.createTab({ paneId: 'pane-b', url: tabUrlB })
        await api.focusTab({ browserTabId: b.browserTabId })
        return { a: a.browserTabId, b: b.browserTabId }
      }, { tabUrlA, tabUrlB })

      await expect.poll(async () => {
        const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        return state.tabRecords.filter((tab) => tab.id === ids.a || tab.id === ids.b).length
      }).toBe(2)

      let state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
      expect(state.windowInfo[0]?.slots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'browser-pane:pane-a', rect: { x: 20, y: 80, w: 300, h: 220 } }),
          expect.objectContaining({ name: 'browser-pane:pane-b', rect: { x: 340, y: 80, w: 360, h: 220 } }),
        ]),
      )
      expect(state.nativeViews[0]?.children.at(-1)?.bounds).toMatchObject({
        x: 340,
        y: 80,
        width: 360,
        height: 220,
      })

      await page.evaluate(async () => {
        const api = window.__browserApi
        await api.setSlot({ paneId: 'pane-b', rect: { x: 100, y: 120, width: 500, height: 260 } })
      })

      await expect.poll(async () => {
        const current = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        return current.nativeViews[0]?.children.at(-1)?.bounds
      }).toMatchObject({ x: 100, y: 120, width: 500, height: 260 })

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1400, height: 900 })
      })
      await expect.poll(async () => {
        const current = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        return current.nativeViews[0]?.children.at(-1)?.bounds
      }).toMatchObject({ x: 100, y: 120, width: 500, height: 260 })

      state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
      expect(state.windowInfo[0]?.slots).toContainEqual(
        expect.objectContaining({ name: 'browser-pane:pane-b', rect: { x: 100, y: 120, w: 500, h: 260 } }),
      )
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
  interface Window {
    __browserApi: {
      setSlot(input: { paneId: string; rect: { x: number; y: number; width: number; height: number } }): Promise<void>
    }
  }
}
