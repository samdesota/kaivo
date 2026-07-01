import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'

const statusPage = `data:text/html,${encodeURIComponent(`
  <!doctype html>
  <h1>1Password Desktop Status</h1>
  <pre id="status">loading</pre>
  <pre id="trigger">not-run</pre>
  <script>
    window.cloudCodeDesktop.getOnePasswordStatus()
      .then((status) => {
        document.querySelector('#status').textContent = status.state
        return window.cloudCodeDesktop.triggerOnePassword()
      })
      .then(() => {
        document.querySelector('#trigger').textContent = 'ok'
      })
      .catch((error) => {
        document.querySelector('#trigger').textContent = 'error:' + error.message
      })
  </script>
`)} `

const installPage = `data:text/html,${encodeURIComponent(`
  <!doctype html>
  <h1>1Password Desktop Install</h1>
  <pre id="status">loading</pre>
  <script>
    window.cloudCodeDesktop.installOnePassword()
      .then((result) => {
        document.querySelector('#status').textContent = result.status.state + ':' + result.status.extensionSource + ':' + result.status.extensionVersion
      })
      .catch((error) => {
        document.querySelector('#status').textContent = 'error:' + error.message
      })
  </script>
`)} `

test('desktop Settings exposes 1Password status without crashing', async ({ desktopLogPath, desktopStateDir }, testInfo) => {
  const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kaivo-1password-extension-'))
  const nativeHostManifestPath = path.join(extensionPath, 'com.1password.1password.json')
  fs.writeFileSync(path.join(extensionPath, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: '1Password',
    version: '1.2.3',
    action: { default_title: '1Password' },
  }))
  fs.writeFileSync(nativeHostManifestPath, JSON.stringify({
    name: 'com.1password.1password',
    path: process.execPath,
    type: 'stdio',
    allowed_origins: ['chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/'],
  }))
  try {
    const app = await electron.launch({
      args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/kaivo-desktop/dist/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'desktop-onepassword-settings-test',
        CC_DESKTOP_CHROME_URL: statusPage,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
        KAIVO_1PASSWORD_EXTENSION_PATH: extensionPath,
        KAIVO_1PASSWORD_NATIVE_HOST_MANIFEST: nativeHostManifestPath,
      },
    })

    try {
      const page = await app.firstWindow()
      await expect(page.getByRole('heading', { name: '1Password Desktop Status' })).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#status')).toHaveText('ready')
      await expect(page.locator('#trigger')).toHaveText(/ok|error:Focus a browser pane before opening 1Password/)
    } finally {
      await app.close().catch(() => undefined)
    }
  } catch (error) {
    await testInfo.attach('desktop-url', {
      body: statusPage,
      contentType: 'text/plain',
    })
    throw error
  } finally {
    fs.rmSync(extensionPath, { recursive: true, force: true })
  }
})

test('desktop installs 1Password from a fixture download URL', async ({ desktopLogPath, desktopStateDir }, testInfo) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaivo-1password-download-'))
  const sourceDir = path.join(fixtureRoot, 'source')
  const zipPath = path.join(fixtureRoot, 'extension.zip')
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: '1Password',
    version: '8.12.0',
    action: { default_title: '1Password' },
  }))
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceDir })

  try {
    const app = await electron.launch({
      args: [path.resolve(process.env.CC_DESKTOP_MAIN ?? 'packages/kaivo-desktop/dist/main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'desktop-onepassword-install-test',
        CC_DESKTOP_CHROME_URL: installPage,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
        KAIVO_1PASSWORD_DOWNLOAD_URL: pathToFileURL(zipPath).toString(),
      },
    })

    try {
      const page = await app.firstWindow()
      await expect(page.getByRole('heading', { name: '1Password Desktop Install' })).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#status')).toHaveText(/^(extension-installed|ready):downloaded:8\.12\.0$/)
    } finally {
      await app.close().catch(() => undefined)
    }
  } catch (error) {
    await testInfo.attach('desktop-url', {
      body: installPage,
      contentType: 'text/plain',
    })
    throw error
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
