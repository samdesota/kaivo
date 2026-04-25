import fs from 'node:fs'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { createApp, createMemoryHistoryStore, createMemoryTabStore, type WebframeApp } from '@samdesota/webframe'
import { resolveDesktopConfig } from './config'

type DesktopLogKind = 'main' | 'chrome-renderer' | 'tab-renderer' | 'crash' | 'exception'

const logPath = process.env.CC_DESKTOP_TEST_LOG
const stateDir = process.env.CC_DESKTOP_TEST_STATE_DIR

let webframeApp: WebframeApp | undefined

function writeLog(kind: DesktopLogKind, level: 'info' | 'error', msg: string, ctx?: Record<string, unknown>): void {
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), kind, level, msg, ctx })}\n`)
}

function trackWindow(win: BrowserWindow): void {
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    writeLog('chrome-renderer', level === 2 ? 'error' : 'info', message, { windowId: win.id, line, sourceId })
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    writeLog('crash', 'error', 'render-process-gone', { windowId: win.id, details })
  })
  win.webContents.on('unresponsive', () => {
    writeLog('crash', 'error', 'renderer-unresponsive', { windowId: win.id })
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
  const config = resolveDesktopConfig()

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
      webPreferences: {
        nodeIntegration: false,
      },
    },
  })
  trackWindow(handle.electronWindow)

  Object.assign(globalThis, {
    cloudCodeDesktopTest: {
      getState: () => ({
        config,
        windowIds: webframeApp?.windows.list().map((window) => window.id) ?? [],
        logPath,
        stateDir,
      }),
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
