import fs from 'node:fs'
import path from 'node:path'
import { app, type BrowserWindow, type WebContents } from 'electron'
import { createApp, createMemoryHistoryStore, createMemoryTabStore, type WebframeApp } from '@samdesota/webframe'
import { resolveDesktopConfig } from './config'

type DesktopLogKind = 'main' | 'chrome-renderer' | 'tab-renderer' | 'crash' | 'exception'

const logPath = process.env.CC_DESKTOP_TEST_LOG
const stateDir = process.env.CC_DESKTOP_TEST_STATE_DIR

let webframeApp: WebframeApp | undefined
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

process.on('uncaughtException', (error) => {
  writeLog('exception', 'error', 'uncaughtException', { message: error.message, stack: error.stack })
})

process.on('unhandledRejection', (reason) => {
  writeLog('exception', 'error', 'unhandledRejection', { reason: String(reason) })
})

async function main(): Promise<void> {
  await app.whenReady()
  const config = resolveDesktopConfig({
    ...process.env,
    NODE_ENV: app.isPackaged ? 'production' : process.env.NODE_ENV,
  })

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
