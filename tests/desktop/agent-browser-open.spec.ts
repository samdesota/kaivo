import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'
import { parseDesktopLogFile } from './harness/logs'

const vitePort = 5195
const chromeUrl = `http://127.0.0.1:${vitePort}/browser-open-pane-fixture.html`
const tabUrl = `http://127.0.0.1:${vitePort}/browser-api-tab.html?agent-open`

test('agent browser open_pane path attaches a real webframe tab', async ({ desktopLogPath, desktopStateDir }, testInfo) => {
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
        CC_INSTANCE_ID: 'desktop-agent-browser-open-test',
        CC_DESKTOP_CHROME_URL: chromeUrl,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
      },
    })

    try {
      const page = await app.firstWindow()
      await expect(page.getByText('Browser Open Pane Fixture')).toBeVisible({ timeout: 15_000 })
      await page.evaluate((url) => window.cloudCodeOpenBrowserPane(url), tabUrl)

      await expect.poll(async () => {
        const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
        return state.tabRecords.some((tab) => tab.url === tabUrl)
      }).toBe(true)

      const state = await app.evaluate(() => globalThis.cloudCodeDesktopTest.getState())
      expect(state.windowInfo[0]?.slots.some((slot) => slot.name.startsWith('browser-pane:'))).toBe(true)

      const browserTabId = state.tabRecords.find((tab) => tab.url === tabUrl)!.id
      const socketPath = state.browserAgentSocketPath!
      const connection = await bridgeCall<{ cdpId: string }>(socketPath, 'connectTab', {
        sandboxId: 'sb-a',
        opencodeSessionId: 'oc-a',
        browserTabId,
      })
      await expect(page.getByText('Agent connected to this tab')).toBeVisible({ timeout: 3_000 })
      await page.getByRole('button', { name: 'Disconnect' }).click()
      await expect.poll(async () => {
        const result = await bridgeCall<{ ok?: true }>(socketPath, 'disconnect', {
          sandboxId: 'sb-a',
          opencodeSessionId: 'oc-a',
          cdpId: connection.cdpId,
        }).catch((error: Error) => ({ error: error.message }))
        return 'error' in result ? result.error : 'still-connected'
      }).toBe('browser connection not found')

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

function bridgeCall<T>(socketPath: string, method: string, params: Record<string, unknown>): Promise<T> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      socket.end()
      const response = JSON.parse(buffer.slice(0, index)) as { result?: T; error?: { message: string } }
      if (response.error) reject(new Error(response.error.message))
      else resolve(response.result as T)
    })
    socket.once('error', reject)
  })
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
    cloudCodeOpenBrowserPane: (url: string) => void
  }
}
