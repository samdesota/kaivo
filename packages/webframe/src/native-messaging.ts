import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ipcMain, webContents as electronWebContents, type ServiceWorkerMain, type Session, type WebFrameMain } from 'electron';
import {
  EXTENSION_ACTION_CLICKED_CHANNEL,
  NATIVE_CONNECT_CHANNEL,
  NATIVE_CONNECT_PORT_CHANNEL,
  NATIVE_PORT_DISCONNECT_CHANNEL,
  NATIVE_PORT_DISCONNECTED_CHANNEL,
  NATIVE_PORT_MESSAGE_CHANNEL,
  NATIVE_PORT_POST_CHANNEL,
  NATIVE_SEND_CHANNEL,
  WEB_NAVIGATION_GET_ALL_FRAMES_CHANNEL,
} from './native-messaging-channels';
import { WebframeError } from './types';

export {
  EXTENSION_ACTION_CLICKED_CHANNEL,
  NATIVE_CONNECT_CHANNEL,
  NATIVE_CONNECT_PORT_CHANNEL,
  NATIVE_PORT_DISCONNECT_CHANNEL,
  NATIVE_PORT_DISCONNECTED_CHANNEL,
  NATIVE_PORT_MESSAGE_CHANNEL,
  NATIVE_PORT_POST_CHANNEL,
  NATIVE_SEND_CHANNEL,
  WEB_NAVIGATION_GET_ALL_FRAMES_CHANNEL,
};

export type ExperimentalNativeMessagingHostInput = {
  manifestPath: string;
  hostName?: string;
  allowedExtensionIds: string[];
};

export type ExperimentalNativeMessagingOptions = {
  hosts?: ExperimentalNativeMessagingHostInput[];
};

export type NativeMessagingHostManifest = {
  name: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
};

type LoadedExtensionLike = { id: string };

type RegisteredNativeHost = {
  manifest: NativeMessagingHostManifest;
  allowedExtensionIds: Set<string>;
};

type NativeMessageRequest = {
  extensionId: string;
  hostName: string;
  message: unknown;
};

type NativePortRequest = {
  extensionId: string;
  hostName: string;
};

type NativePortState = {
  id: string;
  extensionId: string;
  hostName: string;
  child: ChildProcessWithoutNullStreams;
  notify(message: unknown): void;
  notifyDisconnect(error?: string): void;
};

type WebNavigationFrameInfo = {
  frameId: number;
  parentFrameId: number;
  url: string;
};

export type ExtensionActionTab = {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
  windowId?: number;
};

export type ExtensionActionClickOptions = {
  tab?: ExtensionActionTab;
};

export async function readNativeMessagingHostManifest(
  manifestPath: string,
): Promise<NativeMessagingHostManifest> {
  if (!path.isAbsolute(manifestPath)) {
    throw new WebframeError(
      'NATIVE_MESSAGING_MANIFEST_INVALID',
      `native messaging manifest path must be absolute: ${manifestPath}`,
    );
  }
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Partial<NativeMessagingHostManifest>;
  if (!raw.name || typeof raw.name !== 'string') {
    throw new WebframeError('NATIVE_MESSAGING_MANIFEST_INVALID', 'native messaging host name is required');
  }
  if (raw.type !== 'stdio') {
    throw new WebframeError('NATIVE_MESSAGING_MANIFEST_INVALID', 'native messaging host type must be "stdio"');
  }
  if (!raw.path || typeof raw.path !== 'string' || !path.isAbsolute(raw.path)) {
    throw new WebframeError('NATIVE_MESSAGING_MANIFEST_INVALID', 'native messaging host path must be absolute');
  }
  if (!Array.isArray(raw.allowed_origins) || raw.allowed_origins.length === 0) {
    throw new WebframeError(
      'NATIVE_MESSAGING_MANIFEST_INVALID',
      'native messaging host allowed_origins is required',
    );
  }
  for (const origin of raw.allowed_origins) {
    if (typeof origin !== 'string' || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) {
      throw new WebframeError(
        'NATIVE_MESSAGING_MANIFEST_INVALID',
        `native messaging host allowed origin is invalid: ${String(origin)}`,
      );
    }
  }
  return {
    name: raw.name,
    path: raw.path,
    type: raw.type,
    allowed_origins: raw.allowed_origins,
  };
}

export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 1024 * 1024) {
        throw new WebframeError('NATIVE_MESSAGING_FRAME_INVALID', 'native message frame is too large');
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(body));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new WebframeError(
          'NATIVE_MESSAGING_FRAME_INVALID',
          `native message frame is not valid JSON: ${message}`,
        );
      }
    }
    return messages;
  }
}

export async function installExperimentalNativeMessagingBridge(opts: {
  nativeMessaging?: ExperimentalNativeMessagingOptions;
  loadedExtensions: LoadedExtensionLike[];
  session?: Session;
  patchExtensionActions?: boolean;
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): Promise<{ dispose(): void; triggerAction(extensionId: string, options?: ExtensionActionClickOptions): Promise<void> }> {
  const hosts = await loadRegisteredHosts(opts.nativeMessaging, opts.loadedExtensions);
  const ports = new Map<string, NativePortState>();
  const attachedServiceWorkers = new WeakSet<ServiceWorkerMain>();
  const extensionWorkers = new Map<string, ServiceWorkerMain>();
  let preloadId: string | undefined;

  if (opts.session) {
    const serviceWorkerPreload = writeNativeMessagingServiceWorkerPreload({
      patchExtensionActions: opts.patchExtensionActions ?? true,
    });
    preloadId = opts.session.registerPreloadScript({
      type: 'service-worker',
      filePath: serviceWorkerPreload,
      id: 'webframe-native-messaging-service-worker',
    });
    opts.logger?.warn('experimental native messaging service-worker preload registered', {
      preloadId,
      filePath: serviceWorkerPreload,
      preloads: opts.session.getPreloadScripts(),
    });
  }

  ipcMain.handle(NATIVE_SEND_CHANNEL, (_event, request: NativeMessageRequest) =>
    handleSendNativeMessage(hosts, opts.loadedExtensions, request, opts.logger),
  );
  ipcMain.handle(NATIVE_CONNECT_CHANNEL, (_event, request: NativeMessageRequest) =>
    handleConnectNative(hosts, opts.loadedExtensions, request, opts.logger),
  );
  ipcMain.handle(NATIVE_CONNECT_PORT_CHANNEL, (event, request: NativePortRequest) =>
    handleConnectNativePort(hosts, opts.loadedExtensions, ports, request, {
      notify: (payload) => event.sender.send(NATIVE_PORT_MESSAGE_CHANNEL, payload),
      notifyDisconnect: (payload) => event.sender.send(NATIVE_PORT_DISCONNECTED_CHANNEL, payload),
    }, opts.logger),
  );
  ipcMain.handle(NATIVE_PORT_POST_CHANNEL, (_event, request: { extensionId: string; portId: string; message: unknown }) =>
    handleNativePortPost(ports, request.extensionId, request.portId, request.message, opts.logger),
  );
  ipcMain.handle(NATIVE_PORT_DISCONNECT_CHANNEL, (_event, request: { extensionId: string; portId: string }) =>
    handleNativePortDisconnect(ports, request.extensionId, request.portId),
  );
  ipcMain.handle(WEB_NAVIGATION_GET_ALL_FRAMES_CHANNEL, (_event, details: { tabId?: number }) =>
    handleGetAllFrames(details),
  );

  const attachServiceWorker = (worker: ServiceWorkerMain | undefined) => {
    if (!worker || attachedServiceWorkers.has(worker)) return;
    if (!worker.scope.startsWith('chrome-extension://')) return;
    attachedServiceWorkers.add(worker);
    extensionWorkers.set(extensionIdFromScope(worker.scope), worker);
    worker.ipc.handle(NATIVE_SEND_CHANNEL, (event, request: Omit<NativeMessageRequest, 'extensionId'>) =>
      handleSendNativeMessage(hosts, opts.loadedExtensions, {
        ...request,
        extensionId: extensionIdFromScope(event.serviceWorker.scope),
      }, opts.logger),
    );
    worker.ipc.handle(NATIVE_CONNECT_PORT_CHANNEL, (event, request: Omit<NativePortRequest, 'extensionId'>) =>
      handleConnectNativePort(hosts, opts.loadedExtensions, ports, {
        ...request,
        extensionId: extensionIdFromScope(event.serviceWorker.scope),
      }, {
        notify: (payload) => event.serviceWorker.send(NATIVE_PORT_MESSAGE_CHANNEL, payload),
        notifyDisconnect: (payload) => event.serviceWorker.send(NATIVE_PORT_DISCONNECTED_CHANNEL, payload),
      }, opts.logger),
    );
    worker.ipc.handle(NATIVE_PORT_POST_CHANNEL, (event, request: { portId: string; message: unknown }) =>
      handleNativePortPost(ports, extensionIdFromScope(event.serviceWorker.scope), request.portId, request.message, opts.logger),
    );
    worker.ipc.handle(NATIVE_PORT_DISCONNECT_CHANNEL, (event, request: { portId: string }) =>
      handleNativePortDisconnect(ports, extensionIdFromScope(event.serviceWorker.scope), request.portId),
    );
    worker.ipc.handle(WEB_NAVIGATION_GET_ALL_FRAMES_CHANNEL, (_event, details: { tabId?: number }) =>
      handleGetAllFrames(details),
    );
  };

  const onRegistrationCompleted = (_event: unknown, details: { scope: string }) => {
    if (!details.scope.startsWith('chrome-extension://')) return;
    opts.session?.serviceWorkers.startWorkerForScope(details.scope).then(attachServiceWorker).catch((e) => {
      opts.logger?.warn('failed to start extension service worker for native messaging', e);
    });
  };
  const onRunningStatusChanged = (event: { versionId: number; runningStatus: string }) => {
    if (event.runningStatus !== 'running') return;
    attachServiceWorker(opts.session?.serviceWorkers.getWorkerFromVersionID(event.versionId));
  };
  opts.session?.serviceWorkers.on('registration-completed', onRegistrationCompleted);
  opts.session?.serviceWorkers.on('running-status-changed', onRunningStatusChanged);
  for (const info of Object.values(opts.session?.serviceWorkers.getAllRunning() ?? {})) {
    if (!info.scope.startsWith('chrome-extension://')) continue;
    opts.session?.serviceWorkers.startWorkerForScope(info.scope).then(attachServiceWorker).catch(() => undefined);
  }

  opts.logger?.warn('experimental native messaging bridge installed', { hosts: hosts.size });
  return {
    dispose() {
      for (const port of ports.values()) {
        try {
          port.child.kill();
        } catch {
          // ignore
        }
      }
      ports.clear();
      opts.session?.serviceWorkers.off('registration-completed', onRegistrationCompleted);
      opts.session?.serviceWorkers.off('running-status-changed', onRunningStatusChanged);
      if (preloadId) {
        try {
          opts.session?.unregisterPreloadScript(preloadId);
        } catch {
          // ignore
        }
      }
      try {
        ipcMain.removeHandler(NATIVE_SEND_CHANNEL);
      } catch {
        // ignore
      }
      try {
        ipcMain.removeHandler(NATIVE_CONNECT_CHANNEL);
      } catch {
        // ignore
      }
      try {
        ipcMain.removeHandler(NATIVE_CONNECT_PORT_CHANNEL);
      } catch {
        // ignore
      }
      try {
        ipcMain.removeHandler(NATIVE_PORT_POST_CHANNEL);
      } catch {
        // ignore
      }
      try {
        ipcMain.removeHandler(NATIVE_PORT_DISCONNECT_CHANNEL);
      } catch {
        // ignore
      }
      try {
        ipcMain.removeHandler(WEB_NAVIGATION_GET_ALL_FRAMES_CHANNEL);
      } catch {
        // ignore
      }
    },
    async triggerAction(extensionId: string, options: ExtensionActionClickOptions = {}) {
      const worker = await getExtensionWorker(opts.session, extensionWorkers, extensionId);
      if (!worker) {
        throw new WebframeError('EXTENSION_ACTION_UNAVAILABLE', `extension action worker is unavailable: ${extensionId}`);
      }
      attachServiceWorker(worker);
      worker.send(EXTENSION_ACTION_CLICKED_CHANNEL, { tab: options.tab ?? {} });
    },
  };
}

async function loadRegisteredHosts(
  opts: ExperimentalNativeMessagingOptions | undefined,
  loadedExtensions: LoadedExtensionLike[],
): Promise<Map<string, RegisteredNativeHost>> {
  const hosts = new Map<string, RegisteredNativeHost>();
  for (const input of opts?.hosts ?? []) {
    const manifest = await readNativeMessagingHostManifest(input.manifestPath);
    const hostName = input.hostName ?? manifest.name;
    for (const extensionId of input.allowedExtensionIds) {
      if (!manifest.allowed_origins.includes(`chrome-extension://${extensionId}/`)) {
        throw new WebframeError(
          'NATIVE_MESSAGING_EXTENSION_DISALLOWED',
          `native messaging manifest does not allow extension: ${extensionId}`,
        );
      }
    }
    hosts.set(hostName, {
      manifest,
      allowedExtensionIds: new Set(input.allowedExtensionIds),
    });
  }
  return hosts;
}

async function handleSendNativeMessage(
  hosts: Map<string, RegisteredNativeHost>,
  loadedExtensions: LoadedExtensionLike[],
  request: NativeMessageRequest,
  _logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): Promise<unknown> {
  const host = assertNativeMessageAllowed(hosts, loadedExtensions, request);
  const messages = await runNativeHost(host.manifest.path, request.extensionId, request.message, true);
  return messages[0] ?? null;
}

async function handleConnectNative(
  hosts: Map<string, RegisteredNativeHost>,
  loadedExtensions: LoadedExtensionLike[],
  request: NativeMessageRequest,
  _logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): Promise<{ messages: unknown[]; disconnected: true }> {
  const host = assertNativeMessageAllowed(hosts, loadedExtensions, request);
  const messages = await runNativeHost(host.manifest.path, request.extensionId, request.message, true);
  return { messages, disconnected: true };
}

async function handleConnectNativePort(
  hosts: Map<string, RegisteredNativeHost>,
  loadedExtensions: LoadedExtensionLike[],
  ports: Map<string, NativePortState>,
  request: NativePortRequest,
  events: {
    notify(payload: { portId: string; message: unknown }): void;
    notifyDisconnect(payload: { portId: string; error?: string }): void;
  },
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): Promise<{ portId: string }> {
  const host = assertNativeMessageAllowed(hosts, loadedExtensions, request);
  const portId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const port = createNativePort(portId, request.extensionId, request.hostName, host.manifest.path, {
    notify: (message) => events.notify({ portId, message }),
    notifyDisconnect: (error) => events.notifyDisconnect({ portId, error }),
    onClose: () => ports.delete(portId),
  }, logger);
  ports.set(portId, port);
  return { portId };
}

function handleNativePortPost(
  ports: Map<string, NativePortState>,
  extensionId: string,
  portId: string,
  message: unknown,
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): void {
  const port = assertNativePort(ports, extensionId, portId);
  logger?.warn('webframe native messaging port post', {
    extensionId,
    hostName: port.hostName,
    portId,
    message: summarizeNativeMessage(message),
  });
  port.child.stdin.write(encodeNativeMessage(message));
}

function handleNativePortDisconnect(
  ports: Map<string, NativePortState>,
  extensionId: string,
  portId: string,
): void {
  const port = ports.get(portId);
  if (!port || port.extensionId !== extensionId) return;
  ports.delete(portId);
  try {
    port.child.kill();
  } catch {
    // ignore
  }
}

function assertNativeMessageAllowed(
  hosts: Map<string, RegisteredNativeHost>,
  loadedExtensions: LoadedExtensionLike[],
  request: Pick<NativeMessageRequest, 'extensionId' | 'hostName'>,
): RegisteredNativeHost {
  if (!loadedExtensions.some((ext) => ext.id === request.extensionId)) {
    throw new WebframeError(
      'NATIVE_MESSAGING_EXTENSION_DISALLOWED',
      `native messaging extension is not loaded: ${request.extensionId}`,
    );
  }
  const host = hosts.get(request.hostName);
  if (!host || !host.allowedExtensionIds.has(request.extensionId)) {
    throw new WebframeError(
      'NATIVE_MESSAGING_HOST_DISALLOWED',
      `native messaging host is not allowed for extension: ${request.hostName}`,
    );
  }
  return host;
}

function assertNativePort(
  ports: Map<string, NativePortState>,
  extensionId: string,
  portId: string,
): NativePortState {
  const port = ports.get(portId);
  if (!port || port.extensionId !== extensionId) {
    throw new WebframeError('NATIVE_MESSAGING_PORT_INVALID', `native messaging port is invalid: ${portId}`);
  }
  return port;
}

function handleGetAllFrames(details: { tabId?: number }): WebNavigationFrameInfo[] {
  if (typeof details?.tabId !== 'number') return [];
  const contents = electronWebContents.fromId(details.tabId);
  if (!contents || contents.isDestroyed()) return [];
  return collectFrameInfo(contents.mainFrame);
}

function collectFrameInfo(mainFrame: WebFrameMain): WebNavigationFrameInfo[] {
  const frameId = (frame: WebFrameMain) => frame === mainFrame ? 0 : frame.frameTreeNodeId;
  return mainFrame.framesInSubtree
    .filter((frame) => !frame.detached)
    .map((frame) => ({
      frameId: frameId(frame),
      parentFrameId: frame.parent ? frameId(frame.parent) : -1,
      url: frame.url,
    }));
}

function createNativePort(
  id: string,
  extensionId: string,
  hostName: string,
  hostPath: string,
  events: { notify(message: unknown): void; notifyDisconnect(error?: string): void; onClose(): void },
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): NativePortState {
  const child = spawnNativeHost(hostPath, extensionId);
  const parser = new NativeMessageParser();
  let stderr = '';
  let closed = false;

  const disconnect = (error?: string) => {
    if (closed) return;
    closed = true;
    if (error || stderr.trim()) {
      logger?.warn('webframe native messaging port disconnected', {
        extensionId,
        hostName,
        error,
        stderr: stderr.trim() || undefined,
      });
    }
    events.onClose();
    events.notifyDisconnect(error);
  };

  child.stdout.on('data', (chunk: Buffer) => {
    try {
      for (const message of parser.push(chunk)) {
        logger?.warn('webframe native messaging port message', {
          extensionId,
          hostName,
          portId: id,
          message: summarizeNativeMessage(message),
        });
        events.notify(message);
      }
    } catch (e) {
      disconnect(e instanceof Error ? e.message : String(e));
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', (e) => disconnect(e instanceof Error ? e.message : String(e)));
  child.on('close', (code) => {
    const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
    disconnect(code && code !== 0 ? `native messaging host exited with ${code}${detail}` : undefined);
  });

  return { id, extensionId, hostName, child, notify: events.notify, notifyDisconnect: events.notifyDisconnect };
}

function summarizeNativeMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return typeof message;
  const record = message as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ['type', 'kind', 'id', 'requestId', 'message', 'protocol', 'version']) {
    if (key in record && typeof record[key] !== 'object') summary[key] = record[key];
  }
  if ('content' in record && record.content && typeof record.content === 'object') {
    const content = record.content as Record<string, unknown>;
    summary.content = {};
    for (const key of ['type', 'kind', 'id', 'requestId', 'state', 'error']) {
      if (key in content && typeof content[key] !== 'object') (summary.content as Record<string, unknown>)[key] = content[key];
    }
  }
  summary.keys = Object.keys(record).slice(0, 12);
  return summary;
}

function extensionIdFromScope(scope: string): string {
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(scope);
  if (!match) throw new WebframeError('NATIVE_MESSAGING_EXTENSION_DISALLOWED', `invalid extension scope: ${scope}`);
  return match[1];
}

async function getExtensionWorker(
  session: Session | undefined,
  workers: Map<string, ServiceWorkerMain>,
  extensionId: string,
): Promise<ServiceWorkerMain | undefined> {
  const existing = workers.get(extensionId);
  if (existing && !existing.isDestroyed()) return existing;
  const scope = `chrome-extension://${extensionId}/`;
  const worker = await session?.serviceWorkers.startWorkerForScope(scope).catch(() => undefined);
  if (worker) workers.set(extensionId, worker);
  return worker;
}

function runNativeHost(hostPath: string, extensionId: string, message: unknown, endAfterWrite: boolean): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawnNativeHost(hostPath, extensionId);
    const parser = new NativeMessageParser();
    const messages: unknown[] = [];
    let stderr = '';
    let settled = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(err);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        messages.push(...parser.push(chunk));
      } catch (e) {
        fail(e);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code && code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
        reject(new WebframeError('NATIVE_MESSAGING_HOST_FAILED', `native messaging host exited with ${code}${detail}`));
        return;
      }
      resolve(messages);
    });
    child.stdin.write(encodeNativeMessage(message));
    if (endAfterWrite) child.stdin.end();
  });
}

function spawnNativeHost(hostPath: string, extensionId?: string): ChildProcessWithoutNullStreams {
  const args = extensionId ? [`chrome-extension://${extensionId}/`] : [];
  if (hostPath.endsWith('.js') || hostPath.endsWith('.cjs')) {
    return spawn(process.execPath, [hostPath, ...args], {
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  }
  return spawn(hostPath, args, { stdio: 'pipe' });
}

function writeNativeMessagingServiceWorkerPreload(opts: { patchExtensionActions: boolean }): string {
  const dir = path.join(os.tmpdir(), 'webframe-native-messaging');
  fsSync.mkdirSync(dir, { recursive: true });
  const preloadPath = path.join(dir, 'extension-service-worker-preload.cjs');
  fsSync.writeFileSync(preloadPath, nativeMessagingServiceWorkerPreloadSource(opts), 'utf8');
  return preloadPath;
}

function nativeMessagingServiceWorkerPreloadSource(opts: { patchExtensionActions: boolean }): string {
  return `
const { contextBridge, ipcRenderer } = require('electron');
const EXTENSION_ACTION_CLICKED_CHANNEL = ${JSON.stringify(EXTENSION_ACTION_CLICKED_CHANNEL)};
const NATIVE_SEND_CHANNEL = ${JSON.stringify(NATIVE_SEND_CHANNEL)};
const NATIVE_CONNECT_PORT_CHANNEL = ${JSON.stringify(NATIVE_CONNECT_PORT_CHANNEL)};
const NATIVE_PORT_POST_CHANNEL = ${JSON.stringify(NATIVE_PORT_POST_CHANNEL)};
const NATIVE_PORT_DISCONNECT_CHANNEL = ${JSON.stringify(NATIVE_PORT_DISCONNECT_CHANNEL)};
const NATIVE_PORT_MESSAGE_CHANNEL = ${JSON.stringify(NATIVE_PORT_MESSAGE_CHANNEL)};
const NATIVE_PORT_DISCONNECTED_CHANNEL = ${JSON.stringify(NATIVE_PORT_DISCONNECTED_CHANNEL)};
const WEB_NAVIGATION_GET_ALL_FRAMES_CHANNEL = ${JSON.stringify(WEB_NAVIGATION_GET_ALL_FRAMES_CHANNEL)};

try {
  console.info('[webframe] extension service worker preload starting');
  const actionClickListeners = new Set();
  const portMessageListeners = new Set();
  const portDisconnectListeners = new Set();
  ipcRenderer.on(EXTENSION_ACTION_CLICKED_CHANNEL, (_event, payload) => {
    for (const listener of actionClickListeners) listener(payload?.tab || {});
  });
  ipcRenderer.on(NATIVE_PORT_MESSAGE_CHANNEL, (_event, payload) => {
    for (const listener of portMessageListeners) listener(payload);
  });
  ipcRenderer.on(NATIVE_PORT_DISCONNECTED_CHANNEL, (_event, payload) => {
    for (const listener of portDisconnectListeners) listener(payload);
  });
  contextBridge.exposeInMainWorld('__webframeNativeMessaging', {
    onActionClicked: (listener) => {
      actionClickListeners.add(listener);
      return () => actionClickListeners.delete(listener);
    },
    sendNativeMessage: (hostName, message) => ipcRenderer.invoke(NATIVE_SEND_CHANNEL, { hostName, message }),
    connectNativePort: (hostName) => ipcRenderer.invoke(NATIVE_CONNECT_PORT_CHANNEL, { hostName }),
    postNativeMessage: (portId, message) => ipcRenderer.invoke(NATIVE_PORT_POST_CHANNEL, { portId, message }),
    disconnectNativePort: (portId) => ipcRenderer.invoke(NATIVE_PORT_DISCONNECT_CHANNEL, { portId }),
    getAllFrames: (details) => ipcRenderer.invoke(WEB_NAVIGATION_GET_ALL_FRAMES_CHANNEL, details),
    onPortMessage: (listener) => {
      portMessageListeners.add(listener);
      return () => portMessageListeners.delete(listener);
    },
    onPortDisconnected: (listener) => {
      portDisconnectListeners.add(listener);
      return () => portDisconnectListeners.delete(listener);
    },
  });
  contextBridge.executeInMainWorld({ func: () => {
    const PATCH_EXTENSION_ACTIONS = ${JSON.stringify(opts.patchExtensionActions)};
    const bridge = globalThis.__webframeNativeMessaging;
    const runtime = globalThis.chrome?.runtime;
    if (!bridge || !runtime || runtime.__webframeNativeMessagingInstalled) return;
    const createEvent = () => {
      const listeners = new Set();
      return {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
        hasListener: (listener) => listeners.has(listener),
        emit: (...args) => {
          for (const listener of Array.from(listeners)) listener(...args);
        },
      };
    };
    const installWindowConstants = (target) => {
      if (!target) return;
      target.windows ||= {};
      target.windows.WINDOW_ID_NONE ??= -1;
      target.windows.WINDOW_ID_CURRENT ??= -2;
      const currentWindow = () => ({ id: target.windows.WINDOW_ID_CURRENT, focused: true, type: 'normal' });
      target.windows.getCurrent = (_getInfo, callback) => {
        const cb = typeof _getInfo === 'function' ? _getInfo : callback;
        cb?.(currentWindow());
      };
      target.windows.getLastFocused = (_getInfo, callback) => {
        const cb = typeof _getInfo === 'function' ? _getInfo : callback;
        cb?.(currentWindow());
      };
      target.windows.getAll ||= (_getInfo, callback) => {
        const cb = typeof _getInfo === 'function' ? _getInfo : callback;
        cb?.([currentWindow()]);
      };
    };
    const installCommandStubs = (target) => {
      if (!target) return;
      target.commands ||= {};
      target.commands.onCommand ||= createEvent();
      target.commands.getAll ||= (callback) => callback?.([]);
    };
    const installPermissionStubs = (target) => {
      if (!target) return;
      target.permissions ||= {};
      target.permissions.contains ||= (_permissions, callback) => callback?.(false);
      target.permissions.request ||= (_permissions, callback) => callback?.(false);
    };
    const installWebNavigationStubs = (target) => {
      if (!target) return;
      target.webNavigation ||= {};
      target.webNavigation.onBeforeNavigate ||= createEvent();
      target.webNavigation.onCommitted ||= createEvent();
      target.webNavigation.onDOMContentLoaded ||= createEvent();
      target.webNavigation.onCompleted ||= createEvent();
      target.webNavigation.onErrorOccurred ||= createEvent();
      target.webNavigation.getAllFrames ||= (details, callback) => {
        const promise = bridge.getAllFrames(details || {});
        if (typeof callback === 'function') {
          promise.then(
            (frames) => callback(frames),
            (error) => {
              console.error('[webframe] chrome.webNavigation.getAllFrames failed:', error);
              callback(undefined);
            },
          );
          return undefined;
        }
        return promise;
      };
    };
    const installUnsupportedApiStubs = (target) => {
      if (!target) return;
      target.contextMenus ||= {};
      target.contextMenus.onClicked ||= createEvent();
      target.contextMenus.create ||= (_properties, callback) => callback?.();
      target.contextMenus.update ||= (_id, _properties, callback) => callback?.();
      target.contextMenus.remove ||= (_id, callback) => callback?.();
      target.contextMenus.removeAll ||= (callback) => callback?.();
      target.downloads ||= {};
      target.downloads.onChanged ||= createEvent();
      target.downloads.download ||= (_options, callback) => callback?.();
      target.downloads.search ||= (_query, callback) => callback?.([]);
      target.downloads.open ||= (_downloadId) => undefined;
      target.downloads.show ||= (_downloadId) => undefined;
      target.idle ||= {};
      target.idle.onStateChanged ||= createEvent();
      target.idle.queryState ||= (_detectionIntervalInSeconds, callback) => callback?.('active');
      target.privacy ||= {};
      target.privacy.services ||= {};
      target.scripting ||= {};
      target.scripting.executeScript ||= (_injection, callback) => callback?.([]);
      target.scripting.insertCSS ||= (_injection, callback) => callback?.();
      target.scripting.removeCSS ||= (_injection, callback) => callback?.();
      target.tabs ||= {};
      target.tabs.onActivated ||= createEvent();
      target.tabs.onUpdated ||= createEvent();
      target.tabs.onRemoved ||= createEvent();
      target.webRequest ||= {};
      target.webRequest.onAuthRequired ||= createEvent();
    };
    installWindowConstants(globalThis.chrome);
    installCommandStubs(globalThis.chrome);
    installPermissionStubs(globalThis.chrome);
    installWebNavigationStubs(globalThis.chrome);
    installUnsupportedApiStubs(globalThis.chrome);
    let action;
    let notifications;
    if (PATCH_EXTENSION_ACTIONS) {
      action = globalThis.chrome.action || globalThis.chrome.browserAction || {};
      action.onClicked ||= createEvent();
      action.setTitle ||= (_details, callback) => callback?.();
      action.getTitle ||= (_details, callback) => callback?.('');
      action.setIcon ||= (_details, callback) => callback?.();
      action.setPopup ||= (_details, callback) => callback?.();
      action.getPopup ||= (_details, callback) => callback?.('');
      action.setBadgeText ||= (_details, callback) => callback?.();
      action.getBadgeText ||= (_details, callback) => callback?.('');
      action.setBadgeBackgroundColor ||= (_details, callback) => callback?.();
      action.enable ||= (_tabId, callback) => callback?.();
      action.disable ||= (_tabId, callback) => callback?.();
      globalThis.chrome.action = action;
      globalThis.chrome.browserAction = action;
      notifications = globalThis.chrome.notifications || {};
      notifications.onClicked ||= createEvent();
      notifications.onButtonClicked ||= createEvent();
      notifications.onClosed ||= createEvent();
      notifications.clear ||= (_id, callback) => callback?.(true);
      notifications.create ||= (_idOrOptions, _optionsOrCallback, maybeCallback) => {
        const callback = typeof _optionsOrCallback === 'function' ? _optionsOrCallback : maybeCallback;
        callback?.(typeof _idOrOptions === 'string' ? _idOrOptions : 'webframe-notification');
      };
      globalThis.chrome.notifications = notifications;
    }
    const installNativeRuntime = (targetRuntime) => {
      if (!targetRuntime || targetRuntime.__webframeNativeMessagingInstalled) return;
      targetRuntime.sendNativeMessage = function sendNativeMessage(hostName, message, optionsOrCallback, maybeCallback) {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        const promise = bridge.sendNativeMessage(hostName, message);
        if (callback) {
          promise.then(
            (response) => callback(response),
            (error) => {
              console.error('[webframe] chrome.runtime.sendNativeMessage failed:', error);
              callback(undefined);
            },
          );
          return undefined;
        }
        return promise;
      };
      targetRuntime.connectNative = function connectNative(hostName) {
        const onMessage = createEvent();
        const onDisconnect = createEvent();
        const queuedMessages = [];
        let disconnected = false;
        let portId;
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
          for (const message of queuedMessages.splice(0)) bridge.postNativeMessage(id, message);
          return id;
        }, (error) => {
          console.error('[webframe] chrome.runtime.connectNative failed:', error);
          disconnected = true;
          onDisconnect.emit();
          throw error;
        });
        return {
          name: hostName,
          onMessage,
          onDisconnect,
          postMessage(message) {
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
      Object.defineProperty(targetRuntime, '__webframeNativeMessagingInstalled', { value: true });
    };
    const installBrowserActionAliases = (browser) => {
      if (!browser) return;
      installWindowConstants(browser);
      installCommandStubs(browser);
      installPermissionStubs(browser);
      installWebNavigationStubs(browser);
      installUnsupportedApiStubs(browser);
      if (action) browser.action ||= action;
      if (action) browser.browserAction ||= action;
      if (notifications) browser.notifications ||= notifications;
      installNativeRuntime(browser.runtime);
    };
    if (globalThis.browser) {
      installBrowserActionAliases(globalThis.browser);
    } else {
      let browserValue;
      Object.defineProperty(globalThis, 'browser', {
        configurable: true,
        enumerable: true,
        get: () => browserValue,
        set: (value) => {
          browserValue = value;
          installBrowserActionAliases(value);
        },
      });
    }
    if (action) bridge.onActionClicked((tab) => action.onClicked.emit(tab));
    installNativeRuntime(runtime);
    installNativeRuntime(globalThis.browser?.runtime);
  }});
  console.info('[webframe] extension service worker native messaging API installed');
} catch (err) {
  console.error('[webframe] extension service worker preload failed:', err);
}
`;
}
