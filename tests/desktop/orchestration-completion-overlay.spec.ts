import path from 'node:path'
import { spawn } from 'node:child_process'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'

const vitePort = 5196
const appPort = 3196
const fixtureUrl = `http://127.0.0.1:${vitePort}/orchestration-completion-overlay-fixture.html`
const appUrl = `http://127.0.0.1:${appPort}`
const desktopAuthToken = 'desktop-orchestration-completion-token'

test('completion confirmation stays above browser tabs and returns cancel and confirm', async ({ desktopLogPath, desktopStateDir }) => {
  test.setTimeout(60_000)
  const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: path.resolve('.'), env: { ...process.env, CC_APP_URL: appUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const appServer = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.server.json', 'server/index.ts'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(appPort),
      HOST: '127.0.0.1',
      PUBLIC_URL: `http://127.0.0.1:${vitePort}`,
      CC_INSTANCE_ID: 'desktop-orchestration-completion-test',
      CC_SERVICE_CREDENTIAL: 'desktop-orchestration-service-credential',
      CC_DESKTOP_AUTH_TOKEN: desktopAuthToken,
      COOKIE_SECURE: 'false',
      DATA_DIR: path.join(desktopStateDir, 'app-data'),
      APP_SQLITE_PATH: path.join(desktopStateDir, 'app.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForHttp(`${appUrl}/healthz`)
    await waitForHttp(fixtureUrl)
    const authenticatedUrl = `http://127.0.0.1:${vitePort}/internal/desktop-auth?token=${encodeURIComponent(desktopAuthToken)}&next=${encodeURIComponent(fixtureUrl)}`
    const app = await electron.launch({
      args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/kaivo-desktop/dist/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'desktop-orchestration-completion-test',
        CC_DESKTOP_CHROME_URL: authenticatedUrl,
        CC_APP_URL: appUrl,
        CC_DESKTOP_AUTH_TOKEN: desktopAuthToken,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
      },
    })
    try {
      const page = await app.firstWindow()
      await expect(page.getByText('Orchestration Completion Overlay Fixture')).toBeVisible({ timeout: 15_000 })

      await page.getByRole('button', { name: 'Open completion' }).click()
      await expectOverlayText(app, 'Implement parser')
      await expect.poll(async () => {
        const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        return state.nativeViews[0]?.children.at(-1)?.bounds
      }).toMatchObject({ width: 1200, height: 800 })
      await clickOverlayButton(app, 'Cancel')
      await expect(page.getByLabel('Completion result')).toHaveText('false')

      await page.getByRole('button', { name: 'Open completion' }).click()
      await expectOverlayText(app, 'https://github.com/acme/parser/pull/42')
      await clickOverlayButton(app, 'Mark complete')
      await expect(page.getByLabel('Completion result')).toHaveText('true')
    } finally {
      await app.close().catch(() => undefined)
    }
  } finally {
    vite.kill('SIGTERM')
    appServer.kill('SIGTERM')
  }
})

async function expectOverlayText(app: Awaited<ReturnType<typeof electron.launch>>, text: string) {
  await expect.poll(async () => app.evaluate(async ({ webContents }, expected) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL().includes('/internal/overlay-layer'))
    return overlay ? await overlay.executeJavaScript(`document.body.textContent?.includes(${JSON.stringify(expected)})`) : false
  }, text), { timeout: 12_000 }).toBe(true)
}

async function clickOverlayButton(app: Awaited<ReturnType<typeof electron.launch>>, label: string) {
  await app.evaluate(async ({ webContents }, expected) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL().includes('/internal/overlay-layer'))
    if (!overlay) throw new Error('overlay webContents not found')
    await overlay.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(expected)});
      if (!button) throw new Error('overlay button not found');
      button.click();
    })()`)
  }, label)
}

async function waitForHttp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${url}`)
}
