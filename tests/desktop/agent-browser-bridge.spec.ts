import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron } from '@playwright/test'
import { expect, test } from './harness/electron-fixture'

const vitePort = 5196
const chromeUrl = `http://127.0.0.1:${vitePort}/login`
const openedUrl = `http://127.0.0.1:${vitePort}/browser-api-tab.html?bridge-existing`

test('agent browser bridge connects existing tabs', async ({ desktopLogPath, desktopStateDir }, testInfo) => {
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
        CC_INSTANCE_ID: 'desktop-agent-browser-bridge-test',
        CC_DESKTOP_CHROME_URL: chromeUrl,
        CC_DESKTOP_TEST_LOG: desktopLogPath,
        CC_DESKTOP_TEST_STATE_DIR: desktopStateDir,
      },
    })

    try {
      const page = await app.firstWindow()
      await expect(page.getByLabel('Password')).toBeVisible({ timeout: 15_000 })

      await expect.poll(async () => {
        const state = await app.evaluate(() => {
          const testApi = globalThis as unknown as { cloudCodeDesktopTest: { getState: () => Promise<{ browserAgentSocketPath?: string }> } }
          return testApi.cloudCodeDesktopTest.getState()
        })
        return state.browserAgentSocketPath
      }).not.toBeFalsy()
      const socketPath = String(
        (await app.evaluate(() => {
          const testApi = globalThis as unknown as { cloudCodeDesktopTest: { getState: () => Promise<{ browserAgentSocketPath?: string }> } }
          return testApi.cloudCodeDesktopTest.getState()
        })).browserAgentSocketPath,
      )

      const browserTabId = await page.evaluate(async (url) => {
        const mod = await (0, eval)('import("/src/lib/browser-api.ts")')
        const api = mod.createBrowserApi(window)
        await api.setSlot({ paneId: 'pane-a', rect: { x: 20, y: 80, width: 640, height: 360 } })
        const tab = await api.createTab({ paneId: 'pane-a', url })
        return tab.browserTabId
      }, openedUrl)

      const list = await bridgeCall<Array<{ browserTabId: string; connected: boolean }>>(socketPath, 'listTabs', {
        sandboxId: 'sb-a',
        opencodeSessionId: 'oc-a',
      })
      expect(list.some((tab) => tab.browserTabId === browserTabId && !tab.connected)).toBe(true)

      const connected = await bridgeCall<{ cdpId: string; browserTabId: string }>(socketPath, 'connectTab', {
        sandboxId: 'sb-a',
        opencodeSessionId: 'oc-a',
        browserTabId,
      })
      expect(connected.browserTabId).toBe(browserTabId)
      expect(connected.cdpId).toBeTruthy()
      const snapshot = await bridgeCall<{ text: string; interactiveCount: number; url: string }>(socketPath, 'snapshot', {
        sandboxId: 'sb-a',
        opencodeSessionId: 'oc-a',
        cdpId: connected.cdpId,
      })
      expect(snapshot.url).toBe(openedUrl)
      expect(snapshot.text).toContain('"url":"')
      expect(snapshot.interactiveCount).toBeGreaterThanOrEqual(0)
      const inputId = elementIdFor(snapshot.text, 'textbox')
      const buttonId = elementIdFor(snapshot.text, 'button "Save"')
      await bridgeCall(socketPath, 'interact', {
        sandboxId: 'sb-a',
        opencodeSessionId: 'oc-a',
        cdpId: connected.cdpId,
        action: { type: 'fill', fields: [{ elementId: inputId, text: 'Ada' }] },
      })
      await bridgeCall(socketPath, 'interact', {
        sandboxId: 'sb-a',
        opencodeSessionId: 'oc-a',
        cdpId: connected.cdpId,
        action: { type: 'click', elementId: buttonId },
      })
      const js = await bridgeCall<{ value?: unknown }>(socketPath, 'executeJs', {
        sandboxId: 'sb-a',
        opencodeSessionId: 'oc-a',
        cdpId: connected.cdpId,
        expression: 'document.body.dataset.saved',
      })
      expect(js.value).toBe('Ada')
      const image = await bridgeCall<{ base64: string; byteLength: number }>(socketPath, 'screenshot', {
        sandboxId: 'sb-a',
        opencodeSessionId: 'oc-a',
        cdpId: connected.cdpId,
      })
      expect(image.base64.length).toBeGreaterThan(100)
      expect(image.byteLength).toBeGreaterThan(100)
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

function elementIdFor(snapshotText: string, marker: string): string {
  const line = snapshotText.split('\n').find((candidate) => candidate.includes(marker))
  const match = /\[(\d+)]/.exec(line ?? '')
  if (!match?.[1]) throw new Error(`No element id found for ${marker} in:\n${snapshotText}`)
  return match[1]
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
