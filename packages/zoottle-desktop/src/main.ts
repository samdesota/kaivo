import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, webContents as electronWebContents, type WebContents } from 'electron'
import { createApp, createMemoryHistoryStore, createMemoryTabStore, type WebframeApp } from '@samdesota/webframe'
import { resolveDesktopConfig } from './config'
import { desktopBrowserSocketPath, readOrCreateDesktopAuthToken } from './instance-runtime'
import { ensureDesktopServices, type ServiceSupervisor } from './service-supervisor'
import { startBrowserAgentBridge, type BrowserAgentBridge } from './browser-agent-bridge'

type DesktopLogKind = 'main' | 'chrome-renderer' | 'tab-renderer' | 'crash' | 'exception'

const logPath = process.env.CC_DESKTOP_TEST_LOG ?? path.join(app.getPath('logs'), 'desktop.log')
const stateDir = process.env.CC_DESKTOP_TEST_STATE_DIR

let webframeApp: WebframeApp | undefined
let serviceSupervisor: ServiceSupervisor | undefined
let browserAgentBridge: BrowserAgentBridge | undefined
const chromeWebContentsIds = new Set<number>()
const trackedWebContentsIds = new Set<number>()

function chromeUserAgent(): string {
  const chromeVersion = process.versions.chrome
  const platformToken = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

type AppShortcutInput = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

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
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !isAppShortcut(input)) return
    const chrome = findChromeWebContentsForShortcutSender(contents)
    if (!chrome) return
    event.preventDefault()
    sendAppShortcut(chrome, {
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      shiftKey: input.shift,
    })
  })
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

function installAppShortcutMenu(): void {
  const appShortcuts: Array<{ label: string; accelerator: string; input: AppShortcutInput }> = [
    { label: 'Command Palette', accelerator: 'CommandOrControl+K', input: shortcutInput('k', 'KeyK') },
    { label: 'New Browser Tab', accelerator: 'CommandOrControl+T', input: shortcutInput('t', 'KeyT') },
    { label: 'Close Focused Tab', accelerator: 'CommandOrControl+W', input: shortcutInput('w', 'KeyW') },
    { label: 'Toggle Sidebar', accelerator: 'CommandOrControl+B', input: shortcutInput('b', 'KeyB') },
    { label: 'Toggle Agent Pane', accelerator: 'CommandOrControl+G', input: shortcutInput('g', 'KeyG') },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'Kaivo',
      submenu: appShortcuts.map((shortcut) => ({
        label: shortcut.label,
        accelerator: shortcut.accelerator,
        click: () => {
          sendAppShortcut(findChromeWebContentsForFocusedShortcut(), shortcut.input)
        },
      })),
    },
    {
      role: 'editMenu',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]))
}

function shortcutInput(key: string, code: string): AppShortcutInput {
  return {
    key,
    code,
    metaKey: process.platform === 'darwin',
    ctrlKey: process.platform !== 'darwin',
    altKey: false,
    shiftKey: false,
  }
}

function sendAppShortcut(chrome: WebContents | null, input: AppShortcutInput): void {
  if (!chrome || chrome.isDestroyed() || !chromeWebContentsIds.has(chrome.id)) return
  chrome.send('cloud-code/app-shortcut', input)
}

function findChromeWebContentsForFocusedShortcut(): WebContents | null {
  const focusedContents = electronWebContents.getFocusedWebContents()
  if (focusedContents && !focusedContents.isDestroyed()) {
    if (chromeWebContentsIds.has(focusedContents.id)) return focusedContents
    const chrome = findChromeWebContentsForShortcutSender(focusedContents)
    if (chrome) return chrome
  }

  const focusedWindowContents = BrowserWindow.getFocusedWindow()?.webContents
  if (focusedWindowContents && !focusedWindowContents.isDestroyed() && chromeWebContentsIds.has(focusedWindowContents.id)) {
    return focusedWindowContents
  }

  return null
}

function isAppShortcut(input: Electron.Input): boolean {
  if (!input.meta && !input.control) return false
  if (input.alt) return false
  const key = input.key.toLowerCase()
  return key === 'k' || key === 't' || key === 'w' || key === 'b' || key === 'g'
}

function findChromeWebContentsForShortcutSender(contents: WebContents): WebContents | null {
  const bridge = webframeApp?._debug.bridge as unknown as {
    callerForWebContents?: (contents: WebContents) => { kind: string; tabId?: string }
  } | undefined
  const caller = bridge?.callerForWebContents?.(contents)
  if (caller?.kind !== 'tab' || !caller.tabId) return null
  const tabId = caller.tabId

  const windows = webframeApp?.windows.list() as Array<{ tabIds?: string[]; electronWindow: BrowserWindow }> | undefined
  const owner = windows?.find((window) => window.tabIds?.includes(tabId))
  if (!owner || owner.electronWindow.isDestroyed()) return null
  return owner.electronWindow.webContents.isDestroyed() ? null : owner.electronWindow.webContents
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

function findOverlayWebContents(overlayId: string): WebContents | null {
  const bridge = webframeApp?._debug.bridge as unknown as {
    callerForWebContents?: (contents: WebContents) => { kind: string; overlayId?: string }
  } | undefined
  if (!bridge?.callerForWebContents) return null

  for (const contents of electronWebContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue
    const caller = bridge.callerForWebContents(contents)
    if (caller.kind === 'overlay' && caller.overlayId === overlayId) return contents
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
  ipcMain.handle('cloud-code/browser/agent-connections', () => ({
    browserTabIds: browserAgentBridge?.connectedTabs() ?? [],
  }))
  ipcMain.handle('cloud-code/browser/disconnect-agent', (_event, input: { browserTabId?: string }) => {
    if (!input.browserTabId) throw new Error('browserTabId is required')
    browserAgentBridge?.disconnectTab(input.browserTabId)
    return { ok: true as const }
  })
  ipcMain.handle('cloud-code/browser/focus-overlay', (_event, input: { overlayId?: string }) => {
    const overlayId = input.overlayId
    if (!overlayId) throw new Error('overlayId is required')
    const contents = findOverlayWebContents(overlayId)
    if (!contents) throw new Error(`Overlay ${overlayId} not found`)
    const owner = (contents as WebContents & { getOwnerBrowserWindow?: () => BrowserWindow | null }).getOwnerBrowserWindow?.()
    owner?.focus()
    contents.focus()
    return { ok: true as const }
  })
  ipcMain.handle('cloud-code/services/restart-terminal', async () => {
    if (!serviceSupervisor) throw new Error('desktop service supervisor unavailable')
    await serviceSupervisor.restartTerminal()
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
  installAppShortcutMenu()
  installIpcHandlers()
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: app.isPackaged ? 'production' : process.env.NODE_ENV,
  }
  let config = resolveDesktopConfig(baseEnv)
  if (config.manageServices && !baseEnv.CC_DESKTOP_AUTH_TOKEN) {
    config = resolveDesktopConfig({
      ...baseEnv,
      CC_DESKTOP_AUTH_TOKEN: readOrCreateDesktopAuthToken(config.instance),
    })
  }
  if (config.manageServices) {
    serviceSupervisor = await ensureDesktopServices(config.instance, { preserveTerminalOnStop: app.isPackaged })
  }

  app.on('web-contents-created', (_event, contents) => {
    trackWebContents(contents)
  })

  webframeApp = await createApp({
    historyStore: createMemoryHistoryStore(),
    tabStore: createMemoryTabStore(),
    tabUserAgent: chromeUserAgent(),
  })
  writeLog('main', 'info', 'desktop app starting', { stateDir, config })
  browserAgentBridge = await startBrowserAgentBridge({
    socketPath: desktopBrowserSocketPath(config.instance),
    getWebframeApp: () => webframeApp,
    findTabWebContents,
    log: (message, ctx) => writeLog('main', 'info', message, ctx),
  })

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
          browserAgentSocketPath: browserAgentBridge?.socketPath,
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
  void browserAgentBridge?.close().catch((error) => {
    writeLog('exception', 'error', 'browser agent bridge shutdown failed', {
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
