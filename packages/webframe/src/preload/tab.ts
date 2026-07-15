import { contextBridge, ipcRenderer } from 'electron';
import { createWebframeClient } from './client';
import {
  NATIVE_CONNECT_PORT_CHANNEL,
  NATIVE_PORT_DISCONNECT_CHANNEL,
  NATIVE_PORT_DISCONNECTED_CHANNEL,
  NATIVE_PORT_MESSAGE_CHANNEL,
  NATIVE_PORT_POST_CHANNEL,
  NATIVE_SEND_CHANNEL,
} from '../native-messaging-channels';

try {
  const trpc = createWebframeClient(ipcRenderer);
  const api = {
    trpc,
    identity: () => ipcRenderer.invoke('webframe/whoami'),
  };
  contextBridge.exposeInMainWorld('webframe', api);

  if (location.protocol === 'chrome-extension:') {
    const extensionId = location.hostname;
    const portMessageListeners = new Set<(payload: { portId: string; message: unknown }) => void>();
    const portDisconnectListeners = new Set<(payload: { portId: string; error?: string }) => void>();
    ipcRenderer.on(NATIVE_PORT_MESSAGE_CHANNEL, (_event, payload) => {
      for (const listener of portMessageListeners) listener(payload);
    });
    ipcRenderer.on(NATIVE_PORT_DISCONNECTED_CHANNEL, (_event, payload) => {
      for (const listener of portDisconnectListeners) listener(payload);
    });
    contextBridge.exposeInMainWorld('__webframeNativeMessagingFrame', {
      extensionId,
      sendNativeMessage: (hostName: string, message: unknown) =>
        ipcRenderer.invoke(NATIVE_SEND_CHANNEL, { extensionId, hostName, message }),
      connectNativePort: (hostName: string) =>
        ipcRenderer.invoke(NATIVE_CONNECT_PORT_CHANNEL, { extensionId, hostName }),
      postNativeMessage: (portId: string, message: unknown) =>
        ipcRenderer.invoke(NATIVE_PORT_POST_CHANNEL, { extensionId, portId, message }),
      disconnectNativePort: (portId: string) =>
        ipcRenderer.invoke(NATIVE_PORT_DISCONNECT_CHANNEL, { extensionId, portId }),
      onPortMessage: (listener: (payload: { portId: string; message: unknown }) => void) => {
        portMessageListeners.add(listener);
        return () => portMessageListeners.delete(listener);
      },
      onPortDisconnected: (listener: (payload: { portId: string; error?: string }) => void) => {
        portDisconnectListeners.add(listener);
        return () => portDisconnectListeners.delete(listener);
      },
    });
    contextBridge.executeInMainWorld({ func: () => {
      const bridge = (globalThis as typeof globalThis & {
        __webframeNativeMessagingFrame?: {
          sendNativeMessage(hostName: string, message: unknown): Promise<unknown>;
          connectNativePort(hostName: string): Promise<{ portId: string }>;
          postNativeMessage(portId: string, message: unknown): Promise<void>;
          disconnectNativePort(portId: string): Promise<void>;
          onPortMessage(listener: (payload: { portId: string; message: unknown }) => void): () => void;
          onPortDisconnected(listener: (payload: { portId: string; error?: string }) => void): () => void;
        };
      }).__webframeNativeMessagingFrame;
      const runtime = chrome?.runtime as {
        __webframeNativeMessagingFrameInstalled?: boolean;
        sendNativeMessage: unknown;
        connectNative: unknown;
      };
      if (!bridge || !runtime || runtime.__webframeNativeMessagingFrameInstalled) return;
      const createEvent = () => {
        const listeners = new Set<(...args: unknown[]) => void>();
        return {
          addListener: (listener: (...args: unknown[]) => void) => listeners.add(listener),
          removeListener: (listener: (...args: unknown[]) => void) => listeners.delete(listener),
          hasListener: (listener: (...args: unknown[]) => void) => listeners.has(listener),
          emit: (...args: unknown[]) => {
            for (const listener of Array.from(listeners)) listener(...args);
          },
        };
      };
      runtime.sendNativeMessage = function sendNativeMessage(hostName: string, message: unknown, optionsOrCallback?: unknown, maybeCallback?: unknown) {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        const promise = bridge.sendNativeMessage(hostName, message);
        if (typeof callback === 'function') {
          promise.then(
            (response) => callback(response),
            (error) => {
              console.error('[webframe] frame chrome.runtime.sendNativeMessage failed:', error);
              callback(undefined);
            },
          );
          return undefined;
        }
        return promise;
      };
      runtime.connectNative = function connectNative(hostName: string) {
        const onMessage = createEvent();
        const onDisconnect = createEvent();
        const queuedMessages: unknown[] = [];
        let disconnected = false;
        let portId: string | undefined;
        const removeMessageListener = bridge.onPortMessage((payload) => {
          if (payload.portId === portId) onMessage.emit(payload.message);
        });
        const removeDisconnectListener = bridge.onPortDisconnected((payload) => {
          if (payload.portId !== portId) return;
          disconnected = true;
          removeMessageListener();
          removeDisconnectListener();
          onDisconnect.emit();
        });
        const ready = bridge.connectNativePort(hostName).then(({ portId: id }) => {
          portId = id;
          for (const message of queuedMessages.splice(0)) void bridge.postNativeMessage(id, message);
          return id;
        }, (error) => {
          console.error('[webframe] frame chrome.runtime.connectNative failed:', error);
          disconnected = true;
          onDisconnect.emit();
          throw error;
        });
        return {
          name: hostName,
          onMessage,
          onDisconnect,
          postMessage(message: unknown) {
            if (disconnected) throw new Error('Attempting to use a disconnected port object');
            if (portId) void bridge.postNativeMessage(portId, message);
            else queuedMessages.push(message);
          },
          disconnect() {
            if (disconnected) return;
            disconnected = true;
            void ready.then((id) => bridge.disconnectNativePort(id)).catch(() => undefined);
            removeMessageListener();
            removeDisconnectListener();
            onDisconnect.emit();
          },
        };
      };
      Object.defineProperty(runtime, '__webframeNativeMessagingFrameInstalled', { value: true });
    }});
  }
} catch (err) {
  console.error('[webframe] tab preload failed:', err);
}
