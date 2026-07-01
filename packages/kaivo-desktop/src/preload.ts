import { contextBridge, ipcRenderer } from 'electron'
import path from 'node:path'

type AppShortcutInput = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

// Preserve webframe's chrome API when this app supplies an additional preload.
require(path.join(path.dirname(require.resolve('@samdesota/webframe')), 'preload', 'chrome.js'))

ipcRenderer.on('kaivo/app-shortcut', (_event, input: AppShortcutInput) => {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: input.key,
    code: input.code,
    metaKey: input.metaKey,
    ctrlKey: input.ctrlKey,
    altKey: input.altKey,
    shiftKey: input.shiftKey,
    bubbles: true,
    cancelable: true,
  }))
})

contextBridge.exposeInMainWorld('cloudCodeDesktop', {
  kind: 'skeleton',
  openBrowserDevTools: (input: { browserTabId: string }) => ipcRenderer.invoke('kaivo/browser/open-devtools', input),
  findInBrowserPage: (input: { browserTabId: string; text: string; forward?: boolean; findNext?: boolean }) => ipcRenderer.invoke('kaivo/browser/find-in-page', input),
  stopBrowserFindInPage: (input: { browserTabId: string; action?: 'clearSelection' | 'keepSelection' | 'activateSelection' }) => ipcRenderer.invoke('kaivo/browser/stop-find-in-page', input),
  setBrowserZoom: (input: { browserTabId: string; level: number }) => ipcRenderer.invoke('kaivo/browser/set-zoom', input),
  onBrowserFoundInPage: (handler: (input: { browserTabId: string; requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, input: { browserTabId: string; requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => handler(input)
    ipcRenderer.on('kaivo/browser-found-in-page', listener)
    return () => ipcRenderer.removeListener('kaivo/browser-found-in-page', listener)
  },
  getAgentBrowserConnections: () => ipcRenderer.invoke('kaivo/browser/agent-connections'),
  disconnectAgentBrowser: (input: { browserTabId: string }) => ipcRenderer.invoke('kaivo/browser/disconnect-agent', input),
  registerBrowserTabFocusOwner: (input: { browserTabId: string }) => ipcRenderer.send('kaivo/browser/register-tab-focus-owner', input),
  logBrowserDiagnostics: (input: { action: string; paneId?: string; browserTabId?: string; slot?: string; url?: string }) => ipcRenderer.invoke('kaivo/browser/log-diagnostics', input),
  onBrowserTabFocus: (handler: (input: { browserTabId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, input: { browserTabId: string }) => handler(input)
    ipcRenderer.on('kaivo/browser-tab-focused', listener)
    return () => ipcRenderer.removeListener('kaivo/browser-tab-focused', listener)
  },
  focusOverlay: (input: { overlayId: string }) => ipcRenderer.invoke('kaivo/browser/focus-overlay', input),
  registerOverlayOwner: (input: { overlayId: string }) => ipcRenderer.invoke('kaivo/browser/register-overlay-owner', input),
  unregisterOverlayOwner: (input: { overlayId: string }) => ipcRenderer.invoke('kaivo/browser/unregister-overlay-owner', input),
  restartTerminalService: () => ipcRenderer.invoke('kaivo/services/restart-terminal'),
  getOnePasswordStatus: () => ipcRenderer.invoke('kaivo/onepassword/status'),
  installOnePassword: () => ipcRenderer.invoke('kaivo/onepassword/install'),
  resetOnePasswordConfig: () => ipcRenderer.invoke('kaivo/onepassword/reset'),
  saveOnePasswordConfig: (input: { extensionPath: string; nativeHostManifestPath?: string }) => ipcRenderer.invoke('kaivo/onepassword/save-config', input),
  triggerOnePassword: (input?: { browserTabId?: string }) => ipcRenderer.invoke('kaivo/onepassword/trigger', input),
})
