import fs from 'node:fs'
import path from 'node:path'
import { app, ipcMain, webContents as electronWebContents, type BrowserWindow, type WebContents } from 'electron'
import { createApp, createMemoryHistoryStore, createMemoryTabStore, type WebframeApp } from '@samdesota/webframe'
import { resolveDesktopConfig } from './config'
import { ensureDesktopServices, type ServiceSupervisor } from './service-supervisor'

type DesktopLogKind = 'main' | 'chrome-renderer' | 'tab-renderer' | 'crash' | 'exception'

const logPath = process.env.CC_DESKTOP_TEST_LOG ?? path.join(app.getPath('logs'), 'desktop.log')
const stateDir = process.env.CC_DESKTOP_TEST_STATE_DIR

let webframeApp: WebframeApp | undefined
let serviceSupervisor: ServiceSupervisor | undefined
const chromeWebContentsIds = new Set<number>()
const trackedWebContentsIds = new Set<number>()

function writeLog(kind: DesktopLogKind, level: 'info' | 'error', msg: string, ctx?: Record<string, unknown>): void {
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), kind, level, msg, ctx })}\n`)
}

function trackWindow(win: BrowserWindow): void {
  chromeWebContentsIds.add(win.webContents.id)
  trackWebContents(win.webContents)
}

function trackWebContents(contents: WebContents): void {
  if (trackedWebContentsIds.has(contents.id)) return
  trackedWebContentsIds.add(contents.id)
  contents.on('console-message', (_event, level, message, line, sourceId) => {
    const kind = chromeWebContentsIds.has(contents.id) ? 'chrome-renderer' : 'tab-renderer'
    writeLog(kind, level === 2 ? 'error' : 'info', message, { webContentsId: contents.id, line, sourceId })
  })
  contents.on('render-process-gone', (_event, details) => {
    writeLog('crash', 'error', 'render-process-gone', { webContentsId: contents.id, details })
  })
  contents.on('unresponsive', () => {
    writeLog('crash', 'error', 'renderer-unresponsive', { webContentsId: contents.id })
  })
}

function findTabWebContents(browserTabId: string): WebContents | null {
  const bridge = webframeApp?._debug.bridge as unknown as {
    callerForWebContents?: (contents: WebContents) => { kind: string; tabId?: string }
  } | undefined
  if (!bridge?.callerForWebContents) return null

  for (const contents of electronWebContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue
    const caller = bridge.callerForWebContents(contents)
    if (caller.kind === 'tab' && caller.tabId === browserTabId) return contents
  }
  return null
}

function installIpcHandlers(): void {
  ipcMain.handle('cloud-code/browser/open-devtools', (_event, input: { browserTabId?: string }) => {
    const browserTabId = input.browserTabId
    if (!browserTabId) throw new Error('browserTabId is required')
    const contents = findTabWebContents(browserTabId)
    if (!contents) throw new Error(`Browser tab ${browserTabId} not found`)
    contents.openDevTools({ mode: 'detach', activate: true })
    return { ok: true as const }
  })
}

process.on('uncaughtException', (error) => {
  writeLog('exception', 'error', 'uncaughtException', { message: error.message, stack: error.stack })
})

process.on('unhandledRejection', (reason) => {
  writeLog('exception', 'error', 'unhandledRejection', { reason: String(reason) })
})

async function main(): Promise<void> {
  await app.whenReady()
  installIpcHandlers()
  const config = resolveDesktopConfig({
    ...process.env,
    NODE_ENV: app.isPackaged ? 'production' : process.env.NODE_ENV,
  })
  if (config.manageServices) {
    serviceSupervisor = await ensureDesktopServices(config.instance)
  }

  app.on('web-contents-created', (_event, contents) => {
    trackWebContents(contents)
  })

  webframeApp = await createApp({
    historyStore: createMemoryHistoryStore(),
    tabStore: createMemoryTabStore(),
  })
  writeLog('main', 'info', 'desktop app starting', { stateDir, config })

  const handle = await webframeApp.windows.create({
    chromeUrl: config.chromeUrl,
    chromePreload: path.join(__dirname, 'preload.js'),
    electronWindow: {
      width: 1200,
      height: 800,
      frame: false,
      webPreferences: {
        nodeIntegration: false,
      },
    },
  })
  trackWindow(handle.electronWindow)

  Object.assign(globalThis, {
    cloudCodeDesktopTest: {
      getState: async () => {
        const windowInfo = webframeApp ? await webframeApp.caller.windows.list() : []
        const tabRecords = webframeApp ? await webframeApp.caller.tabs.list() : []
        const nativeViews =
          webframeApp?.windows.list().map((window) => {
            const contentView = window.electronWindow.contentView as unknown as {
              children?: Array<{
                getBounds?: () => { x: number; y: number; width: number; height: number }
                webContents?: { id: number }
              }>
            }
            return {
              windowId: window.id,
              children: (contentView.children ?? []).map((child, index) => ({
                index,
                webContentsId: child.webContents?.id,
                bounds: child.getBounds?.(),
              })),
            }
          }) ?? []
        return {
          config,
          windowIds: webframeApp?.windows.list().map((window) => window.id) ?? [],
          windowInfo,
          tabRecords,
          nativeViews,
          logPath,
          stateDir,
        }
      },
    },
  })
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  void serviceSupervisor?.stop().catch((error) => {
    writeLog('exception', 'error', 'service supervisor shutdown failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  })
  void webframeApp?.stop().catch((error) => {
    writeLog('exception', 'error', 'webframe shutdown failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  })
})

void main().catch((error) => {
  writeLog('exception', 'error', 'desktop skeleton startup failed', {
    message: error instanceof Error ? error.message : String(error),
  })
  app.quit()
})
