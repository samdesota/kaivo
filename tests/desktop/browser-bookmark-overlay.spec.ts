import http from 'node:http'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'

const vitePort = 5195
const appPort = 3195
const chromeUrl = `http://127.0.0.1:${vitePort}/browser-bookmark-fixture.html`
const appUrl = `http://127.0.0.1:${appPort}`
const desktopAuthToken = 'desktop-bookmark-overlay-token-12345'
const faviconDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

test('browser pane bookmark action opens overlay and saves a bookmark', async ({ desktopLogPath, desktopStateDir }, testInfo) => {
  test.setTimeout(60_000)
  const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: path.resolve('.'),
    env: { ...process.env, CC_APP_URL: appUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const appServer = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.server.json', 'server/index.ts'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(appPort),
      HOST: '127.0.0.1',
      PUBLIC_URL: `http://127.0.0.1:${vitePort}`,
      CC_INSTANCE_ID: 'desktop-browser-bookmark-overlay-test',
      CC_SERVICE_CREDENTIAL: 'desktop-bookmark-service-credential',
      CC_DESKTOP_AUTH_TOKEN: desktopAuthToken,
      COOKIE_SECURE: 'false',
      DATA_DIR: path.join(desktopStateDir, 'app-data'),
      APP_SQLITE_PATH: path.join(desktopStateDir, 'app.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const viteLogs: string[] = []
  const appLogs: string[] = []
  vite.stdout?.on('data', (chunk) => viteLogs.push(String(chunk)))
  vite.stderr?.on('data', (chunk) => viteLogs.push(String(chunk)))
  appServer.stdout?.on('data', (chunk) => appLogs.push(String(chunk)))
  appServer.stderr?.on('data', (chunk) => appLogs.push(String(chunk)))

  try {
    await waitForHttp(`${appUrl}/healthz`)
    await waitForHttp(chromeUrl)
    const authenticatedChromeUrl = `http://127.0.0.1:${vitePort}/internal/desktop-auth?token=${encodeURIComponent(desktopAuthToken)}&next=${encodeURIComponent(chromeUrl)}`
    const app = await electron.launch({
      args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/zoottle-desktop/dist/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'desktop-browser-bookmark-overlay-test',
        CC_DESKTOP_CHROME_URL: authenticatedChromeUrl,
        CC_APP_URL: appUrl,
        CC_DESKTOP_AUTH_TOKEN: desktopAuthToken,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
      },
    })

    try {
      const page = await app.firstWindow()
      await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('/browser-bookmark-fixture.html')
      await expect(page.getByText('Browser Bookmark Fixture')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByLabel('URL')).toBeVisible()
      await expect(page.getByLabel('Bookmark page')).toBeEnabled()
      expect(await page.evaluate(() => Boolean((window as Window & { webframe?: { trpc?: { overlays?: { createDetached?: unknown } } } }).webframe?.trpc?.overlays?.createDetached))).toBe(true)
      await expect.poll(async () => {
        const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        return state.tabRecords.length
      }).toBeGreaterThan(0)

      await page.getByLabel('URL').press(process.platform === 'darwin' ? 'Meta+D' : 'Control+D')

      await expect.poll(async () => page.evaluate(() => window.localStorage.getItem('__zoottle_bookmark_overlay_requested'))).toBe('https://example.com/docs')
      const rejection = await page.evaluate(() => window.localStorage.getItem('__zoottle_last_unhandled_rejection'))
      expect(rejection).toBeNull()

      await expect.poll(async () => {
        const overlayUrls = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.getURL()))
        return overlayUrls.join('\n')
      }, { timeout: 12_000 }).toContain('/internal/overlay-layer')
      await expect.poll(async () => {
        const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        const last = state.nativeViews[0]?.children.at(-1)?.bounds
        return { width: last?.width ?? 0, height: last?.height ?? 0 }
      }).toMatchObject({ width: 1200, height: 800 })

      await app.evaluate(async ({ webContents }) => {
        const overlay = webContents.getAllWebContents().find((contents) => contents.getURL().includes('/internal/overlay-layer'))
        if (!overlay) throw new Error('overlay webContents not found')
        await overlay.executeJavaScript(`
          const buttons = Array.from(document.querySelectorAll('button'));
          const save = buttons.find((button) => button.textContent?.trim() === 'Save');
          if (!save) throw new Error('Save button not found');
          save.click();
        `)
      })

      await expect.poll(async () => {
        return await page.evaluate(() => JSON.parse(window.localStorage.getItem('__zoottle_mock_bookmark_mutation_calls') || '[]'))
      }).toEqual([
        expect.objectContaining({
          url: 'https://example.com/docs',
          faviconDataUrl,
          faviconUrl: 'https://example.com/favicon.ico',
        }),
      ])

      const urlInput = page.getByRole('textbox', { name: 'URL' })
      await urlInput.click()
      await urlInput.fill('plain search')
      await expect.poll(async () => app.evaluate(async ({ webContents }) => {
        const overlay = webContents.getAllWebContents().find((contents) => contents.getURL().includes('/internal/overlay-layer'))
        if (!overlay) return ''
        return await overlay.executeJavaScript('document.body.textContent || ""')
      })).toContain('Search web for "plain search"')
      await urlInput.press('Enter')
      await expect.poll(async () => {
        const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        return state.tabRecords.map((tab) => tab.url)
      }).toContain('https://www.google.com/search?q=plain%20search')

      await urlInput.click()
      await urlInput.fill('Seed')
      await expect(urlInput).toHaveValue('Seed')
      await expect.poll(async () => app.evaluate(async ({ webContents }) => {
        for (const overlay of webContents.getAllWebContents().filter((contents) => contents.getURL().includes('/internal/overlay-layer'))) {
          const result = await overlay.executeJavaScript(`(() => {
            const list = document.querySelector('[aria-label="URL bar results"]');
            const seed = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Seed Bookmark'));
            if (!list || !seed) return null;
            const rect = seed.getBoundingClientRect();
            return {
              imageCount: list.querySelectorAll('img').length,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            };
          })()`)
          if (!result) continue
          if (result.imageCount !== 1) return 'missing icon'
          overlay.sendInputEvent({ type: 'mouseDown', x: result.x, y: result.y, button: 'left', clickCount: 1 })
          overlay.sendInputEvent({ type: 'mouseUp', x: result.x, y: result.y, button: 'left', clickCount: 1 })
          return 'clicked'
        }
        return 'not found'
      })).toBe('clicked')
      await expect.poll(async () => {
        const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        return state.tabRecords.map((tab) => tab.url)
      }).toContain('https://example.com/seed')
    } finally {
      await app.close().catch(() => undefined)
    }
  } catch (error) {
    await testInfo.attach('vite-log-tail', {
      body: viteLogs.slice(-40).join(''),
      contentType: 'text/plain',
    })
    await testInfo.attach('app-log-tail', {
      body: appLogs.slice(-40).join(''),
      contentType: 'text/plain',
    })
    throw error
  } finally {
    await stopProcess(vite)
    await stopProcess(appServer)
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
