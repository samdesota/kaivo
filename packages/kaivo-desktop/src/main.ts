import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, screen, session as electronSession, webContents as electronWebContents, type WebContents } from 'electron'
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
const devToolsWindows = new Map<number, BrowserWindow>()
const browserTabFocusOwners = new Map<string, number>()
const overlayOwners = new Map<number, Set<string>>()
type SidebarZone = { width: number; wasInside: boolean; pendingLeftTimer: NodeJS.Timeout | null }
const sidebarZones = new Map<number, SidebarZone>()
let sidebarZoneTimer: NodeJS.Timeout | null = null

type WindowBounds = { x?: number; y?: number; width: number; height: number }

const devToolsBoundsPath = path.join(stateDir ?? app.getPath('userData'), 'devtools-window-bounds.json')

function chromeUserAgent(): string {
  const chromeMajorVersion = process.versions.chrome.split('.')[0] ?? process.versions.chrome
  const kaivoVersion = app.getVersion()
  const platformToken = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Kaivo/${kaivoVersion} Chrome/${chromeMajorVersion}.0.0.0 Safari/537.36`
}

const browserTabUserAgent = chromeUserAgent()
const browserTabSessionPartition = 'persist:webframe'

app.userAgentFallback = browserTabUserAgent

type AppShortcutInput = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

type FindInPageResult = {
  browserTabId: string
  requestId: number
  activeMatchOrdinal: number
  matches: number
  selectionArea?: { x: number; y: number; width: number; height: number }
  finalUpdate: boolean
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
  contents.on('focus', () => {
    notifyChromeOfFocusedBrowserTab(contents)
  })
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) closeOwnedOverlays(contents.id, 'owner navigation')
  })
  contents.on('destroyed', () => {
    deleteSidebarZone(contents.id)
    updateSidebarZoneTimer()
    closeOwnedOverlays(contents.id, 'owner destroyed')
  })
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') notifyChromeOfFocusedBrowserTab(contents)
  })
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && isReloadShortcut(input)) {
      const chrome = findChromeWebContentsForShortcutSender(contents) ?? (chromeWebContentsIds.has(contents.id) ? contents : findChromeWebContentsForFocusedWindow())
      if (chrome) {
        event.preventDefault()
        reloadShortcutSender(contents, chrome)
      }
      return
    }
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
  contents.on('found-in-page', (_event, result) => {
    const browserTabId = findBrowserTabIdForWebContents(contents)
    if (!browserTabId) return
    const chrome = findChromeWebContentsForBrowserTab(browserTabId) ?? findChromeWebContentsForShortcutSender(contents)
    if (!chrome || chrome.isDestroyed()) return
    chrome.send('kaivo/browser-found-in-page', {
      browserTabId,
      requestId: result.requestId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      selectionArea: result.selectionArea,
      finalUpdate: result.finalUpdate,
    } satisfies FindInPageResult)
  })
  contents.on('console-message', (_event, level, message, line, sourceId) => {
    const kind = chromeWebContentsIds.has(contents.id) ? 'chrome-renderer' : 'tab-renderer'
    writeLog(kind, level === 2 ? 'error' : 'info', message, { webContentsId: contents.id, line, sourceId })
  })
  contents.on('render-process-gone', (_event, details) => {
    writeLog('crash', 'error', 'render-process-gone', { webContentsId: contents.id, details })
    closeOwnedOverlays(contents.id, 'owner render process gone')
  })
  contents.on('unresponsive', () => {
    writeLog('crash', 'error', 'renderer-unresponsive', { webContentsId: contents.id })
  })
}

function updateSidebarZone(ownerWebContentsId: number, input: { enabled?: boolean; width?: number }): void {
  if (!input.enabled) {
    deleteSidebarZone(ownerWebContentsId)
    updateSidebarZoneTimer()
    return
  }
  const contents = electronWebContents.fromId(ownerWebContentsId)
  const win = contents && !contents.isDestroyed()
    ? (contents as WebContents & { getOwnerBrowserWindow?: () => BrowserWindow | null }).getOwnerBrowserWindow?.()
    : null
  const width = Math.max(1, Math.round(input.width ?? 256))
  const existing = sidebarZones.get(ownerWebContentsId)
  if (existing?.pendingLeftTimer) clearTimeout(existing.pendingLeftTimer)
  sidebarZones.set(ownerWebContentsId, { width, wasInside: isCursorInsideSidebarZone(win ?? null, width), pendingLeftTimer: null })
  updateSidebarZoneTimer()
}

function deleteSidebarZone(ownerWebContentsId: number): void {
  const zone = sidebarZones.get(ownerWebContentsId)
  if (zone?.pendingLeftTimer) clearTimeout(zone.pendingLeftTimer)
  sidebarZones.delete(ownerWebContentsId)
}

function updateSidebarZoneTimer(): void {
  if (sidebarZones.size > 0 && sidebarZoneTimer === null) {
    sidebarZoneTimer = setInterval(checkSidebarZones, 50)
    return
  }
  if (sidebarZones.size === 0 && sidebarZoneTimer !== null) {
    clearInterval(sidebarZoneTimer)
    sidebarZoneTimer = null
  }
}

function checkSidebarZones(): void {
  for (const [ownerWebContentsId, zone] of sidebarZones) {
    const contents = electronWebContents.fromId(ownerWebContentsId)
    if (!contents || contents.isDestroyed()) {
      sidebarZones.delete(ownerWebContentsId)
      continue
    }
    const win = (contents as WebContents & { getOwnerBrowserWindow?: () => BrowserWindow | null }).getOwnerBrowserWindow?.()
    const point = screen.getCursorScreenPoint()
    const bounds = win && !win.isDestroyed() ? win.getBounds() : null
    const insideWindow = !!bounds
      && point.x >= bounds.x
      && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y
      && point.y <= bounds.y + bounds.height
    const inside = isCursorInsideSidebarZoneBounds(bounds, zone.width, point)

    if (zone.pendingLeftTimer && insideWindow) {
      clearTimeout(zone.pendingLeftTimer)
      zone.pendingLeftTimer = null
    }

    if (zone.wasInside && !inside) {
      if (bounds && point.x < bounds.x) {
        zone.wasInside = false
        if (!zone.pendingLeftTimer) {
          zone.pendingLeftTimer = setTimeout(() => {
            const latest = sidebarZones.get(ownerWebContentsId)
            if (!latest) return
            latest.pendingLeftTimer = null
            const latestContents = electronWebContents.fromId(ownerWebContentsId)
            const latestWin = latestContents && !latestContents.isDestroyed()
              ? (latestContents as WebContents & { getOwnerBrowserWindow?: () => BrowserWindow | null }).getOwnerBrowserWindow?.()
              : null
            const latestPoint = screen.getCursorScreenPoint()
            const latestBounds = latestWin && !latestWin.isDestroyed() ? latestWin.getBounds() : null
            const backInsideWindow = !!latestBounds
              && latestPoint.x >= latestBounds.x
              && latestPoint.x <= latestBounds.x + latestBounds.width
              && latestPoint.y >= latestBounds.y
              && latestPoint.y <= latestBounds.y + latestBounds.height
            if (backInsideWindow) return
            latestContents?.send('kaivo/sidebar-zone-left')
          }, 300)
        }
        continue
      }
      contents.send('kaivo/sidebar-zone-left')
      zone.wasInside = false
      continue
    }
    zone.wasInside = inside
  }
  updateSidebarZoneTimer()
}

function isCursorInsideSidebarZone(win: BrowserWindow | null, width: number): boolean {
  if (!win || win.isDestroyed()) return false
  return isCursorInsideSidebarZoneBounds(win.getBounds(), width, screen.getCursorScreenPoint())
}

function isCursorInsideSidebarZoneBounds(
  bounds: Electron.Rectangle | null,
  width: number,
  point: Electron.Point,
): boolean {
  if (!bounds) return false
  return point.x >= bounds.x
    && point.x <= bounds.x + width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height
}

function registerOverlayOwner(ownerWebContentsId: number, overlayId: string): void {
  let overlays = overlayOwners.get(ownerWebContentsId)
  if (!overlays) {
    overlays = new Set<string>()
    overlayOwners.set(ownerWebContentsId, overlays)
  }
  overlays.add(overlayId)
  writeLog('main', 'info', 'registered overlay owner', { ownerWebContentsId, overlayId })
}

function unregisterOverlayOwner(ownerWebContentsId: number, overlayId: string): void {
  const overlays = overlayOwners.get(ownerWebContentsId)
  if (!overlays) return
  overlays.delete(overlayId)
  if (overlays.size === 0) overlayOwners.delete(ownerWebContentsId)
  writeLog('main', 'info', 'unregistered overlay owner', { ownerWebContentsId, overlayId })
}

function closeOwnedOverlays(ownerWebContentsId: number, reason: string): void {
  const overlays = overlayOwners.get(ownerWebContentsId)
  if (!overlays?.size) return
  overlayOwners.delete(ownerWebContentsId)
  const overlayIds = Array.from(overlays)
  writeLog('main', 'info', 'closing owned overlays', { ownerWebContentsId, reason, overlayIds })
  for (const overlayId of overlayIds) {
    void closeOverlayFromMain(overlayId, reason).catch((error) => {
      writeLog('exception', 'error', 'owned overlay close failed', {
        ownerWebContentsId,
        overlayId,
        reason,
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }
}

async function closeOverlayFromMain(overlayId: string, reason: string): Promise<void> {
  await webframeApp?.caller.overlays.close({ overlayId })
  writeLog('main', 'info', 'closed overlay from main', { overlayId, reason })
}

function notifyChromeOfFocusedBrowserTab(contents: WebContents): void {
  const bridge = webframeApp?._debug.bridge as unknown as {
    callerForWebContents?: (contents: WebContents) => { kind: string; tabId?: string }
  } | undefined
  const caller = bridge?.callerForWebContents?.(contents)
  if (caller?.kind !== 'tab' || !caller.tabId) return
  const chrome = findChromeWebContentsForBrowserTab(caller.tabId) ?? findChromeWebContentsForShortcutSender(contents)
  if (!chrome || chrome.isDestroyed()) return
  chrome.send('kaivo/browser-tab-focused', { browserTabId: caller.tabId })
}

function installAppShortcutMenu(): void {
  const appShortcuts: Array<{ label: string; accelerator: string; input: AppShortcutInput }> = [
    { label: 'Find in Page', accelerator: 'CommandOrControl+F', input: shortcutInput('f', 'KeyF') },
    { label: 'Command Palette', accelerator: 'CommandOrControl+K', input: shortcutInput('k', 'KeyK') },
    { label: 'Command Palette in Global Tabs', accelerator: 'CommandOrControl+Shift+K', input: shortcutInput('K', 'KeyK', { shiftKey: true }) },
    { label: 'New Browser Tab', accelerator: 'CommandOrControl+T', input: shortcutInput('t', 'KeyT') },
    { label: 'New Workspace Chat', accelerator: 'CommandOrControl+Shift+T', input: shortcutInput('T', 'KeyT', { shiftKey: true }) },
    { label: 'Close Focused Tab', accelerator: 'CommandOrControl+W', input: shortcutInput('w', 'KeyW') },
    { label: 'Toggle Sidebar', accelerator: 'CommandOrControl+B', input: shortcutInput('b', 'KeyB') },
    { label: 'Toggle Agent Pane', accelerator: 'CommandOrControl+G', input: shortcutInput('g', 'KeyG') },
    { label: 'Zoom In Browser Pane', accelerator: 'CommandOrControl+Plus', input: shortcutInput('+', 'Equal') },
    { label: 'Zoom Out Browser Pane', accelerator: 'CommandOrControl+-', input: shortcutInput('-', 'Minus') },
    { label: 'Reset Browser Pane Zoom', accelerator: 'CommandOrControl+0', input: shortcutInput('0', 'Digit0') },
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

function shortcutInput(key: string, code: string, options?: { shiftKey?: boolean }): AppShortcutInput {
  return {
    key,
    code,
    metaKey: process.platform === 'darwin',
    ctrlKey: process.platform !== 'darwin',
    altKey: false,
    shiftKey: options?.shiftKey ?? false,
  }
}

function sendAppShortcut(chrome: WebContents | null, input: AppShortcutInput): void {
  if (!chrome || chrome.isDestroyed() || !chromeWebContentsIds.has(chrome.id)) {
    writeLog('main', 'error', 'app shortcut dropped: chrome webcontents unavailable', { input })
    return
  }
  writeLog('main', 'info', 'app shortcut sent to chrome', {
    chromeWebContentsId: chrome.id,
    input,
    focusedWebContentsId: electronWebContents.getFocusedWebContents()?.id,
    focusedWindowWebContentsId: BrowserWindow.getFocusedWindow()?.webContents.id,
  })
  chrome.send('kaivo/app-shortcut', input)
}

function reloadShortcutSender(sender: WebContents, chrome: WebContents): void {
  writeLog('main', 'info', 'reload shortcut handled by sender webcontents', {
    chromeWebContentsId: chrome.id,
    senderWebContentsId: sender.id,
    url: safeWebContentsUrl(sender),
  })
  sender.reload()
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

function findChromeWebContentsForFocusedWindow(): WebContents | null {
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
  if (key === 'k' || key === 't' || key === 'w' || key === 'b' || key === 'g' || key === 'f') return true
  return isZoomShortcut(input)
}

function isZoomShortcut(input: Electron.Input): boolean {
  if (!input.meta && !input.control) return false
  if (input.alt) return false
  const key = input.key.toLowerCase()
  return key === '+' || key === '=' || key === '-' || key === '_' || key === '0'
}

function isReloadShortcut(input: Electron.Input): boolean {
  if (!input.meta && !input.control) return false
  if (input.alt || input.shift) return false
  return input.key.toLowerCase() === 'r'
}

function findChromeWebContentsForShortcutSender(contents: WebContents): WebContents | null {
  const host = contents.hostWebContents
  if (host && !host.isDestroyed() && chromeWebContentsIds.has(host.id)) return host

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

function findChromeWebContentsForBrowserTab(browserTabId: string): WebContents | null {
  const registeredChromeId = browserTabFocusOwners.get(browserTabId)
  const registeredChrome = registeredChromeId === undefined ? null : electronWebContents.fromId(registeredChromeId)
  if (registeredChrome && !registeredChrome.isDestroyed() && chromeWebContentsIds.has(registeredChrome.id)) {
    return registeredChrome
  }
  return null
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

function findBrowserTabIdForWebContents(contents: WebContents): string | null {
  const bridge = webframeApp?._debug.bridge as unknown as {
    callerForWebContents?: (contents: WebContents) => { kind: string; tabId?: string }
  } | undefined
  const caller = bridge?.callerForWebContents?.(contents)
  return caller?.kind === 'tab' && caller.tabId ? caller.tabId : null
}

type NativeViewSnapshot = {
  windowId: string
  children: Array<{
    index: number
    webContentsId?: number
    bounds?: { x: number; y: number; width: number; height: number }
    browserTabId?: string | null
    url?: string
  }>
}

type BrowserDiagnosticsSlot = { name: string; rect?: unknown }
type BrowserDiagnosticsWindow = { id: string; slots?: BrowserDiagnosticsSlot[] }
type BrowserDiagnosticsTab = { id: string; [key: string]: unknown }

function getNativeViewSnapshots(): NativeViewSnapshot[] {
  return webframeApp?.windows.list().map((window) => {
    const contentView = window.electronWindow.contentView as unknown as {
      children?: Array<{
        getBounds?: () => { x: number; y: number; width: number; height: number }
        webContents?: WebContents
      }>
    }
    return {
      windowId: window.id,
      children: (contentView.children ?? []).map((child, index) => ({
        index,
        webContentsId: child.webContents?.id,
        bounds: child.getBounds?.(),
        browserTabId: child.webContents ? findBrowserTabIdForWebContents(child.webContents) : null,
        url: child.webContents && !child.webContents.isDestroyed() ? safeWebContentsUrl(child.webContents) : undefined,
      })),
    }
  }) ?? []
}

async function getBrowserDiagnostics(input: { action: string; paneId?: string; browserTabId?: string; slot?: string; url?: string }): Promise<Record<string, unknown>> {
  const windowInfo = webframeApp ? await webframeApp.caller.windows.list() as BrowserDiagnosticsWindow[] : []
  const tabRecords = webframeApp ? await webframeApp.caller.tabs.list() as BrowserDiagnosticsTab[] : []
  const matchingSlots = input.slot
    ? windowInfo.flatMap((window) => (window.slots ?? []).filter((slot) => slot.name === input.slot).map((slot) => ({ windowId: window.id, slot })))
    : []
  const matchingTab = input.browserTabId
    ? tabRecords.find((tab) => tab.id === input.browserTabId) ?? null
    : null
  const nativeViews = getNativeViewSnapshots()
  const matchingNativeViews = input.browserTabId
    ? nativeViews.flatMap((window) => window.children.filter((child) => child.browserTabId === input.browserTabId).map((child) => ({ windowId: window.windowId, child })))
    : []

  return {
    action: input.action,
    paneId: input.paneId,
    browserTabId: input.browserTabId,
    slot: input.slot,
    url: input.url,
    windowCount: windowInfo.length,
    tabCount: tabRecords.length,
    nativeViewCount: nativeViews.reduce((count, window) => count + window.children.length, 0),
    matchingSlots,
    matchingTab,
    matchingNativeViews,
  }
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
  ipcMain.handle('kaivo/browser/open-devtools', (_event, input: { browserTabId?: string }) => {
    const browserTabId = input.browserTabId
    if (!browserTabId) throw new Error('browserTabId is required')
    const contents = findTabWebContents(browserTabId)
    if (!contents) throw new Error(`Browser tab ${browserTabId} not found`)
    openFloatingDevTools(contents)
    return { ok: true as const }
  })
  ipcMain.handle('kaivo/browser/find-in-page', (_event, input: { browserTabId?: string; text?: string; forward?: boolean; findNext?: boolean }) => {
    const browserTabId = input.browserTabId
    if (!browserTabId) throw new Error('browserTabId is required')
    const contents = findTabWebContents(browserTabId)
    if (!contents) throw new Error(`Browser tab ${browserTabId} not found`)
    const text = input.text ?? ''
    if (!text) {
      contents.stopFindInPage('clearSelection')
      return { requestId: null }
    }
    return {
      requestId: contents.findInPage(text, {
        forward: input.forward ?? true,
        findNext: input.findNext ?? false,
      }),
    }
  })
  ipcMain.handle('kaivo/browser/stop-find-in-page', (_event, input: { browserTabId?: string; action?: 'clearSelection' | 'keepSelection' | 'activateSelection' }) => {
    const browserTabId = input.browserTabId
    if (!browserTabId) throw new Error('browserTabId is required')
    const contents = findTabWebContents(browserTabId)
    if (!contents) throw new Error(`Browser tab ${browserTabId} not found`)
    contents.stopFindInPage(input.action ?? 'clearSelection')
    return { ok: true as const }
  })
  ipcMain.handle('kaivo/browser/set-zoom', (_event, input: { browserTabId?: string; level?: number }) => {
    const browserTabId = input.browserTabId
    if (!browserTabId) throw new Error('browserTabId is required')
    const contents = findTabWebContents(browserTabId)
    if (!contents) throw new Error(`Browser tab ${browserTabId} not found`)
    const current = contents.getZoomLevel()
    const next = Math.max(-6, Math.min(6, typeof input.level === 'number' ? input.level : current))
    contents.setZoomLevel(next)
    return { zoomLevel: next }
  })
  ipcMain.handle('kaivo/browser/agent-connections', () => ({
    browserTabIds: browserAgentBridge?.connectedTabs() ?? [],
  }))
  ipcMain.handle('kaivo/browser/disconnect-agent', (_event, input: { browserTabId?: string }) => {
    if (!input.browserTabId) throw new Error('browserTabId is required')
    browserAgentBridge?.disconnectTab(input.browserTabId)
    return { ok: true as const }
  })
  ipcMain.handle('kaivo/browser/focus-overlay', (_event, input: { overlayId?: string }) => {
    const overlayId = input.overlayId
    if (!overlayId) throw new Error('overlayId is required')
    const contents = findOverlayWebContents(overlayId)
    if (!contents) throw new Error(`Overlay ${overlayId} not found`)
    const owner = (contents as WebContents & { getOwnerBrowserWindow?: () => BrowserWindow | null }).getOwnerBrowserWindow?.()
    owner?.focus()
    contents.focus()
    return { ok: true as const }
  })
  ipcMain.handle('kaivo/browser/register-overlay-owner', (event, input: { overlayId?: string }) => {
    if (!input.overlayId) throw new Error('overlayId is required')
    if (!chromeWebContentsIds.has(event.sender.id)) throw new Error('overlay owner must be a chrome webContents')
    registerOverlayOwner(event.sender.id, input.overlayId)
    return { ok: true as const }
  })
  ipcMain.handle('kaivo/browser/unregister-overlay-owner', (event, input: { overlayId?: string }) => {
    if (!input.overlayId) throw new Error('overlayId is required')
    unregisterOverlayOwner(event.sender.id, input.overlayId)
    return { ok: true as const }
  })
  ipcMain.handle('kaivo/sidebar-zone/update', (event, input: { enabled?: boolean; width?: number }) => {
    if (!chromeWebContentsIds.has(event.sender.id)) throw new Error('sidebar zone owner must be a chrome webContents')
    updateSidebarZone(event.sender.id, input)
    return { ok: true as const }
  })
  ipcMain.on('kaivo/browser/register-tab-focus-owner', (event, input: { browserTabId?: string }) => {
    if (!input.browserTabId) return
    if (!chromeWebContentsIds.has(event.sender.id)) return
    browserTabFocusOwners.set(input.browserTabId, event.sender.id)
  })
  ipcMain.handle('kaivo/browser/log-diagnostics', async (_event, input: { action?: string; paneId?: string; browserTabId?: string; slot?: string; url?: string }) => {
    const diagnostics = await getBrowserDiagnostics({
      action: input.action ?? 'unknown',
      paneId: input.paneId,
      browserTabId: input.browserTabId,
      slot: input.slot,
      url: input.url,
    })
    writeLog('main', 'info', 'browser diagnostics', diagnostics)
    return diagnostics
  })
  ipcMain.handle('kaivo/services/restart-terminal', async () => {
    if (!serviceSupervisor) throw new Error('desktop service supervisor unavailable')
    await serviceSupervisor.restartTerminal()
    return { ok: true as const }
  })
}

function safeWebContentsUrl(contents: WebContents): string | undefined {
  try {
    return contents.getURL()
  } catch {
    return undefined
  }
}

function openFloatingDevTools(contents: WebContents): void {
  const existing = devToolsWindows.get(contents.id)
  if (existing && !existing.isDestroyed()) {
    existing.setAlwaysOnTop(true, 'floating')
    existing.focus()
    return
  }

  const devToolsWindow = new BrowserWindow({
    ...readDevToolsWindowBounds(),
    title: contents.getDevToolsTitle(),
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  devToolsWindows.set(contents.id, devToolsWindow)
  devToolsWindow.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') devToolsWindow.setVisibleOnAllWorkspaces(true)
  devToolsWindow.on('moved', () => saveDevToolsWindowBounds(devToolsWindow))
  devToolsWindow.on('resized', () => saveDevToolsWindowBounds(devToolsWindow))

  const cleanup = () => {
    if (devToolsWindows.get(contents.id) === devToolsWindow) devToolsWindows.delete(contents.id)
    if (!contents.isDestroyed()) {
      contents.off('devtools-closed', cleanup)
      contents.off('destroyed', cleanup)
    }
    if (!devToolsWindow.isDestroyed()) devToolsWindow.destroy()
  }

  devToolsWindow.on('closed', () => {
    if (devToolsWindows.get(contents.id) === devToolsWindow) devToolsWindows.delete(contents.id)
    if (!contents.isDestroyed() && contents.isDevToolsOpened()) contents.closeDevTools()
  })
  contents.once('devtools-closed', cleanup)
  contents.once('destroyed', cleanup)
  contents.setDevToolsWebContents(devToolsWindow.webContents)
  contents.openDevTools({ mode: 'detach', activate: true })
  devToolsWindow.focus()
  writeLog('main', 'info', 'opened floating browser devtools', {
    inspectedWebContentsId: contents.id,
    devToolsWindowId: devToolsWindow.id,
    devToolsWebContentsId: devToolsWindow.webContents.id,
  })
}

function readDevToolsWindowBounds(): WindowBounds {
  try {
    const parsed = JSON.parse(fs.readFileSync(devToolsBoundsPath, 'utf8')) as WindowBounds
    if (Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
      return {
        x: Number.isFinite(parsed.x) ? parsed.x : undefined,
        y: Number.isFinite(parsed.y) ? parsed.y : undefined,
        width: Math.max(480, parsed.width),
        height: Math.max(360, parsed.height),
      }
    }
  } catch {
    // Use the default bounds until the user moves/resizes DevTools.
  }
  return { width: 820, height: 560 }
}

function saveDevToolsWindowBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.getBounds()
  fs.mkdirSync(path.dirname(devToolsBoundsPath), { recursive: true })
  fs.writeFileSync(devToolsBoundsPath, JSON.stringify(bounds))
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

  const browserTabSession = electronSession.fromPartition(browserTabSessionPartition)
  browserTabSession.setUserAgent(browserTabUserAgent)

  webframeApp = await createApp({
    historyStore: createMemoryHistoryStore(),
    tabStore: createMemoryTabStore(),
    session: browserTabSession,
    tabUserAgent: browserTabUserAgent,
    logger: {
      warn: (message: unknown, ctx?: unknown) => writeLog('main', 'info', 'webframe warn', { message: String(message), ctx }),
      error: (message: unknown, ctx?: unknown) => writeLog('main', 'error', 'webframe error', { message: String(message), ctx }),
    },
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
        const nativeViews = getNativeViewSnapshots()
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
