import { contextBridge, ipcRenderer } from 'electron';
import { createWebframeClient } from '../src/preload/client';

try {
  const trpc = createWebframeClient(ipcRenderer);
  contextBridge.exposeInMainWorld('webframe', {
    trpc,
    identity: () => ipcRenderer.invoke('webframe/whoami'),
    onePassword: {
      triggerAction: (args: { extensionId: string; tabId?: string }) =>
        ipcRenderer.invoke('webframe/test/1password-trigger-action', args),
      openPopup: (args: { extensionId: string; windowId: string; placement: { x: number; y: number; w: number; h: number } }) =>
        ipcRenderer.invoke('webframe/test/1password-open-popup', args),
      closePopup: () => ipcRenderer.invoke('webframe/test/1password-close-popup'),
    },
    devtools: {
      openForTab: (args: { tabId?: string }) => ipcRenderer.invoke('webframe/test/open-tab-devtools', args),
    },
  });
} catch (err) {
  console.error('[webframe] test-app chrome preload failed:', err);
}
