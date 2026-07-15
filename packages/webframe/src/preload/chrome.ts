import { contextBridge, ipcRenderer } from 'electron';
import { createWebframeClient } from './client';

try {
  const trpc = createWebframeClient(ipcRenderer);
  const api = {
    trpc,
    identity: () => ipcRenderer.invoke('webframe/whoami'),
  };
  contextBridge.exposeInMainWorld('webframe', api);
} catch (err) {
  console.error('[webframe] chrome preload failed:', err);
}
