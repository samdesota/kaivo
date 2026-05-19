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

ipcRenderer.on('cloud-code/app-shortcut', (_event, input: AppShortcutInput) => {
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
  openBrowserDevTools: (input: { browserTabId: string }) => ipcRenderer.invoke('cloud-code/browser/open-devtools', input),
  getAgentBrowserConnections: () => ipcRenderer.invoke('cloud-code/browser/agent-connections'),
  disconnectAgentBrowser: (input: { browserTabId: string }) => ipcRenderer.invoke('cloud-code/browser/disconnect-agent', input),
  registerBrowserTabFocusOwner: (input: { browserTabId: string }) => ipcRenderer.send('cloud-code/browser/register-tab-focus-owner', input),
  onBrowserTabFocus: (handler: (input: { browserTabId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, input: { browserTabId: string }) => handler(input)
    ipcRenderer.on('cloud-code/browser-tab-focused', listener)
    return () => ipcRenderer.removeListener('cloud-code/browser-tab-focused', listener)
  },
  focusOverlay: (input: { overlayId: string }) => ipcRenderer.invoke('cloud-code/browser/focus-overlay', input),
  restartTerminalService: () => ipcRenderer.invoke('cloud-code/services/restart-terminal'),
})
