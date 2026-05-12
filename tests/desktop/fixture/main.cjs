/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const logPath = process.env.CC_DESKTOP_TEST_LOG
const stateDir = process.env.CC_DESKTOP_TEST_STATE_DIR

const state = {
  windowIds: [],
  webframeAppState: { status: 'fixture' },
  tabRecords: [],
  slotBounds: {},
  activeTabIds: [],
  logPath,
  stateDir,
}

function writeLog(kind, level, msg, ctx) {
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), kind, level, msg, ctx })}\n`)
}

function trackWindow(win, kind) {
  state.windowIds.push(win.id)
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    writeLog(kind, level === 2 ? 'error' : 'info', message, { windowId: win.id, line, sourceId })
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

ipcMain.handle('fixture:get-state', () => state)
ipcMain.handle('fixture:emit-unhandled', () => {
  process.emit('unhandledRejection', new Error('fixture unhandled rejection'), Promise.resolve())
})

app.whenReady().then(async () => {
  writeLog('main', 'info', 'fixture starting', { stateDir })

  const chrome = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  })
  trackWindow(chrome, 'chrome-renderer')

  const tab = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  })
  trackWindow(tab, 'tab-renderer')
  state.tabRecords.push({ id: 'fixture-tab', url: 'about:blank', title: 'Fixture Tab' })
  state.activeTabIds.push('fixture-tab')
  state.slotBounds['fixture-slot'] = { x: 10, y: 20, width: 300, height: 200 }

  await tab.loadURL('data:text/html,<script>console.log("tab renderer ready")</script>')
  await chrome.loadURL(`data:text/html,${encodeURIComponent(`
    <!doctype html>
    <html>
      <body>
        <h1>Desktop Fixture</h1>
        <button id="ping">Ping</button>
        <script>
          const { ipcRenderer } = require('electron')
          window.fixture = {
            getState: () => ipcRenderer.invoke('fixture:get-state'),
            emitUnhandled: () => ipcRenderer.invoke('fixture:emit-unhandled'),
          }
          document.querySelector('#ping').addEventListener('click', () => console.log('chrome ping'))
          console.log('chrome renderer ready')
        </script>
      </body>
    </html>
  `)}`)
})

app.on('window-all-closed', () => app.quit())
