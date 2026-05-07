import { contextBridge, ipcRenderer } from 'electron'
import path from 'node:path'

// Preserve webframe's chrome API when this app supplies an additional preload.
require(path.join(path.dirname(require.resolve('@samdesota/webframe')), 'preload', 'chrome.js'))

contextBridge.exposeInMainWorld('cloudCodeDesktop', {
  kind: 'skeleton',
  openBrowserDevTools: (input: { browserTabId: string }) => ipcRenderer.invoke('cloud-code/browser/open-devtools', input),
  getAgentBrowserConnections: () => ipcRenderer.invoke('cloud-code/browser/agent-connections'),
  disconnectAgentBrowser: (input: { browserTabId: string }) => ipcRenderer.invoke('cloud-code/browser/disconnect-agent', input),
  restartTerminalService: () => ipcRenderer.invoke('cloud-code/services/restart-terminal'),
})
