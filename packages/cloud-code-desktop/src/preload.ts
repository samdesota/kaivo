import { contextBridge, ipcRenderer } from 'electron'

// Preserve webframe's chrome API when this app supplies an additional preload.
require('@samdesota/webframe/dist/preload/chrome.js')

contextBridge.exposeInMainWorld('cloudCodeDesktop', {
  kind: 'skeleton',
  openBrowserDevTools: (input: { browserTabId: string }) => ipcRenderer.invoke('cloud-code/browser/open-devtools', input),
})
