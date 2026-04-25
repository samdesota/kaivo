import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('cloudCodeDesktop', {
  kind: 'skeleton',
})
