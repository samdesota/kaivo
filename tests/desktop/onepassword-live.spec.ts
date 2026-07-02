import path from 'node:path'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'

const extensionPath = process.env.KAIVO_1PASSWORD_EXTENSION_PATH
const nativeHostManifestPath = process.env.KAIVO_1PASSWORD_NATIVE_HOST_MANIFEST

test.describe('1Password live smoke', () => {
  test.skip(!extensionPath, 'Set KAIVO_1PASSWORD_EXTENSION_PATH to run the live 1Password smoke test')

  test('loads configured 1Password extension status through the desktop bridge', async ({ desktopLogPath, desktopStateDir }) => {
    const app = await electron.launch({
      args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/kaivo-desktop/dist/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'desktop-onepassword-live-test',
        CC_DESKTOP_CHROME_URL: liveStatusPage,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
      },
    })

    try {
      const page = await app.firstWindow()
      await expect(page.locator('#status')).toHaveText(/extension-installed|ready/, { timeout: 15_000 })
      const status = await page.evaluate(async () => (window as any).cloudCodeDesktop.getOnePasswordStatus()) as {
        state: string
        extensionPath?: string
        nativeHostManifestPath?: string
        nativeHostState: string
      }

      expect(status.extensionPath).toBe(extensionPath)
      expect(['extension-installed', 'ready']).toContain(status.state)
      if (nativeHostManifestPath) {
        expect(status.nativeHostManifestPath).toBe(nativeHostManifestPath)
        expect(status.nativeHostState).toBe('valid')
      }
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})

const liveStatusPage = `data:text/html,${encodeURIComponent(`
  <!doctype html>
  <h1>1Password Live Smoke</h1>
  <pre id="status">loading</pre>
  <script>
    window.cloudCodeDesktop.getOnePasswordStatus()
      .then((status) => {
        document.querySelector('#status').textContent = status.state
      })
      .catch((error) => {
        document.querySelector('#status').textContent = 'error:' + error.message
      })
  </script>
`)} `
