import http from 'node:http'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'

const vitePort = 5196
const appPort = 3196
const appUrl = `http://127.0.0.1:${appPort}`
const chromeUrl = `http://127.0.0.1:${vitePort}`
const desktopAuthToken = 'desktop-global-tabs-token-1234567890'

test('global browser tabs activate from sidebar and can be created with shortcuts', async ({ desktopLogPath, desktopStateDir }, testInfo) => {
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
      PUBLIC_URL: chromeUrl,
      CC_INSTANCE_ID: 'desktop-global-tabs-sidebar-test',
      CC_SERVICE_CREDENTIAL: 'desktop-global-tabs-service-credential',
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
    const authenticatedChromeUrl = `${chromeUrl}/internal/desktop-auth?token=${encodeURIComponent(desktopAuthToken)}&next=${encodeURIComponent('/')}`
    const app = await electron.launch({
      args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/zoottle-desktop/dist/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'desktop-global-tabs-sidebar-test',
        CC_DESKTOP_CHROME_URL: authenticatedChromeUrl,
        CC_APP_URL: appUrl,
        CC_DESKTOP_AUTH_TOKEN: desktopAuthToken,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
      },
    })

    try {
      const page = await app.firstWindow()
      await expect(page.getByRole('link', { name: 'Untitled workspace' })).toBeVisible({ timeout: 20_000 })
      const workspaceLink = page.getByRole('link', { name: 'Untitled workspace' })
      await expect(workspaceLink).toHaveAttribute('aria-current', 'page')

      await page.evaluate(async () => {
        const mod = await (0, eval)('import("/src/lib/trpc-plain.ts")') as {
          appTrpcMutation<T>(path: string, input?: unknown): Promise<T>
        }
        const workspace = await mod.appTrpcMutation<{ id: string }>('workspace.getOrCreateGlobalTabsWorkspace')
        await mod.appTrpcMutation('workspace.upsertTab', {
          workspaceId: workspace.id,
          tab: {
            id: 'global-e2e-tab',
            type: 'browser',
            url: 'https://example.com/global-tabs-e2e',
            title: 'Global E2E',
          },
          position: 0,
        })
      })
      await page.reload({ waitUntil: 'domcontentloaded' })

      const globalTab = page.getByRole('button', { name: 'Global E2E', exact: true })
      await expect(globalTab).toBeVisible({ timeout: 20_000 })
      await globalTab.click()

      await expect(page.locator('section[aria-label="Global tabs"] button[aria-current="page"]').first()).toBeVisible()
      await expect(workspaceLink).not.toHaveAttribute('aria-current', 'page')
      await expect(page.getByLabel('Global browser tab')).toBeVisible()
      await expect(page.getByLabel('URL')).toHaveValue('https://example.com/global-tabs-e2e')

      await workspaceLink.click()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+T')
      await submitUniversalMenu(app, '@example.com/workspace-shortcut-e2e')
      await expect(page.getByLabel('URL')).toHaveValue('https://example.com/workspace-shortcut-e2e')
      await expect(page.getByRole('button', { name: 'https://example.com/workspace-shortcut-e2e', exact: true })).toHaveCount(0)

      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+T' : 'Control+Shift+T')
      await submitUniversalMenu(app, 'example.com/global-shortcut-e2e')
      const shortcutGlobalTab = page.getByRole('button', { name: 'https://example.com/global-shortcut-e2e', exact: true })
      await expect(shortcutGlobalTab).toBeVisible({ timeout: 20_000 })
      await expect(shortcutGlobalTab).toHaveAttribute('aria-current', 'page')
      await expect(workspaceLink).not.toHaveAttribute('aria-current', 'page')
      await expect(page.getByLabel('Global browser tab')).toBeVisible()
      await expect(page.getByLabel('URL')).toHaveValue('https://example.com/global-shortcut-e2e')
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

async function submitUniversalMenu(app: Awaited<ReturnType<typeof electron.launch>>, value: string): Promise<void> {
  await expect.poll(async () => {
    const urls = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.getURL()))
    return urls.join('\n')
  }, { timeout: 12_000 }).toContain('/internal/overlay-layer')
  await expect.poll(async () => app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents().filter((candidate) => candidate.getURL().includes('/internal/overlay-layer'))) {
      const hasInput = await contents.executeJavaScript(`Boolean(document.querySelector('input[aria-label="Universal menu search"], form input'))`).catch(() => false)
      if (hasInput) return true
    }
    return false
  }), { timeout: 12_000 }).toBe(true)
  await app.evaluate(async ({ webContents }, inputValue) => {
    let overlay: ReturnType<typeof webContents.getAllWebContents>[number] | null = null
    for (const contents of webContents.getAllWebContents().filter((candidate) => candidate.getURL().includes('/internal/overlay-layer'))) {
      const hasInput = await contents.executeJavaScript(`Boolean(document.querySelector('input[aria-label="Universal menu search"], form input'))`).catch(() => false)
      if (hasInput) {
        overlay = contents
        break
      }
    }
    if (!overlay) throw new Error('overlay webContents not found')
    const serialized = JSON.stringify(inputValue)
    const result = await overlay.executeJavaScript(`(() => {
      try {
        const input = document.querySelector('input[aria-label="Universal menu search"], form input');
        if (!(input instanceof HTMLInputElement)) throw new Error('overlay input not found');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, ${serialized});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const form = input.closest('form');
        if (form) form.requestSubmit();
        else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    })()`)
    if (!result?.ok) throw new Error(result?.message ?? 'failed to submit universal menu')
  }, value)
  await expect.poll(async () => app.evaluate(async ({ webContents }) => {
    let count = 0
    for (const contents of webContents.getAllWebContents().filter((candidate) => candidate.getURL().includes('/internal/overlay-layer'))) {
      const hasInput = await contents.executeJavaScript(`Boolean(document.querySelector('input[aria-label="Universal menu search"], form input'))`).catch(() => false)
      if (hasInput) count += 1
    }
    return count
  }), { timeout: 12_000 }).toBe(0)
}

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
