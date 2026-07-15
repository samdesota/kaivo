import * as path from 'node:path';
import {
  app as electronApp,
  ipcMain,
  session as electronSession,
  webContents,
  type BaseWindow,
  type Session,
  type WebContents,
} from 'electron';
import { Bridge, CallerRegistry } from './bridge';
import { EventBus } from './bus';
import {
  createChromeExtensionRuntime,
  type ChromeExtensionRuntime,
  type ChromeExtensionRuntimeOptions,
} from './chrome-extension-runtime';
import {
  collectExtensionDebugInfo,
  createExtensionDiagnostics,
  loadWebframeExtensions,
  type ExtensionDebugInfo,
  type ExtensionInput,
  type LoadedExtensionInfo,
} from './extensions';
import { OverlayManager } from './overlay';
import {
  installExperimentalNativeMessagingBridge,
  type ExtensionActionClickOptions,
  type ExperimentalNativeMessagingOptions,
} from './native-messaging';
import { createCallerFactory, createRouter, type AppCaller, type AppRouter } from './router';
import type { HistoryStore, TabStore } from './stores/types';
import { TabManager } from './tab';
import type { WindowOptions, WindowHandle } from './window';
import { WindowManager } from './window';

export { createMemoryHistoryStore, createMemoryTabStore } from './stores/memory';
export type { HistoryStore, TabStore } from './stores/types';
export type { AppRouter } from './router';
export type {
  Rect,
  Slot,
  Anchor,
  TabRecord,
  HistoryEntry,
  WindowInfo,
  OverlayInfo,
  Caller,
  LifecyclePhase,
  LifecycleEvent,
  TabChangeEvent,
  TabMovedEvent,
  ResizeEvent,
} from './types';
export { WebframeError } from './types';
export type { WindowOptions, WindowHandle } from './window';

export type CreateAppOptions = {
  historyStore: HistoryStore;
  tabStore: TabStore;
  /** Partition name ("persist:foo") or an Electron Session instance. Default: "persist:webframe". */
  session?: string | Session;
  /** Optional user agent applied to tab and popup WebContents. */
  tabUserAgent?: string;
  /** Absolute path to a preload for tab WebContents. */
  tabPreload?: string;
  /** Absolute path to a preload for overlay WebContents. */
  overlayPreload?: string;
  /** Unpacked browser extensions to load into the shared persistent session. */
  extensions?: ExtensionInput[];
  /** Experimental native messaging shim for extension-loading spikes. */
  nativeMessaging?: ExperimentalNativeMessagingOptions;
  /** Browser-like extension API polyfills backed by electron-chrome-extensions. */
  chromeExtensions?: ChromeExtensionRuntimeOptions;
  /** Optional logger. Defaults to console. */
  logger?: {
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
};

export type WebframeApp = {
  router: AppRouter;
  caller: AppCaller;
  windows: {
    create(opts: WindowOptions): Promise<WindowHandle>;
    get(id: string): WindowHandle | undefined;
    list(): WindowHandle[];
  };
  tabs: {
    getWebContents(tabId: string): WebContents | undefined;
  };
  extensions: {
    triggerAction(extensionId: string, options?: { tabId?: string } & ExtensionActionClickOptions): Promise<void>;
  };
  stop(): Promise<void>;
  /** Internal hooks for tests. Unstable. */
    _debug: {
      subCount(wcId: number): number;
      bridge: Bridge;
      extensions: LoadedExtensionInfo[];
      extensionDiagnostics(): ExtensionDebugInfo;
      extensionPages(): string[];
    };
};

/** Resolve the absolute path to the default chrome preload shipped with webframe. */
function defaultChromePreloadPath(): string {
  // dist/preload/chrome.js relative to dist/index.js
  return path.resolve(__dirname, 'preload', 'chrome.js');
}

/** Resolve the absolute path to the default tab preload shipped with webframe. */
function defaultTabPreloadPath(): string {
  return path.resolve(__dirname, 'preload', 'tab.js');
}

function findElectronWindow(windowManager: WindowManager, electronWindowId?: number) {
  const windows = windowManager.list();
  if (typeof electronWindowId === 'number') {
    const match = windows.find((w) => w.electronWindow.id === electronWindowId);
    if (match) return match;
  }
  return windows[0];
}

function findElectronWindowForTab(
  windowManager: WindowManager,
  tabManager: TabManager,
  wc: WebContents,
) {
  const tabId = tabManager.getTabIdForWebContents(wc);
  if (!tabId) return undefined;
  return windowManager.list().find((w) => w.tabIds.includes(tabId));
}

export async function createApp(opts: CreateAppOptions): Promise<WebframeApp> {
  if (!electronApp.isReady()) {
    await electronApp.whenReady();
  }

  const logger = opts.logger ?? {
    warn: (...a: unknown[]) => console.warn('[webframe]', ...a),
    error: (...a: unknown[]) => console.error('[webframe]', ...a),
  };

  const sessionArg = opts.session ?? 'persist:webframe';
  const session: Session =
    typeof sessionArg === 'string' ? electronSession.fromPartition(sessionArg) : sessionArg;
  const extensionDiagnostics = createExtensionDiagnostics();

  const bus = new EventBus();
  const registry = new CallerRegistry();

  // Forward-declare managers so deps can reference each other.
  let windowManager!: WindowManager;
  let tabManager!: TabManager;
  let overlayManager!: OverlayManager;
  let chromeExtensionRuntime: ChromeExtensionRuntime | undefined;

  chromeExtensionRuntime = createChromeExtensionRuntime({
    session,
    options: opts.chromeExtensions,
    async createTab(details) {
      const targetWindow = findElectronWindow(windowManager, details.windowId);
      if (!targetWindow) throw new Error('No WebFrame window is available for chrome.tabs.create');
      const rec = await tabManager.create({
        url: details.url ?? 'about:blank',
        windowId: targetWindow.id,
        placement: { slot: 'content' },
        active: details.active ?? true,
      });
      const wc = tabManager.getWebContents(rec.id);
      if (!wc) throw new Error('Created WebFrame tab has no WebContents');
      return [wc, targetWindow.electronWindow as BaseWindow];
    },
    selectTab(tab) {
      const tabId = tabManager.getTabIdForWebContents(tab);
      const win = findElectronWindowForTab(windowManager, tabManager, tab);
      if (tabId && win) tabManager.setActive(tabId, win.id);
    },
    removeTab(tab) {
      const tabId = tabManager.getTabIdForWebContents(tab);
      if (tabId) void tabManager.close(tabId).catch((e) => logger.warn('chrome extension tab remove failed', e));
    },
    assignTabDetails(details, tab) {
      const win = findElectronWindowForTab(windowManager, tabManager, tab);
      details.id = tab.id;
      details.windowId = win?.electronWindow.id ?? details.windowId;
      details.url = tab.getURL();
      details.title = tab.getTitle();
      details.active = Boolean(win && tabManager.getTabIdForWebContents(tab));
    },
    async createWindow() {
      throw new Error('chrome.windows.create is not implemented by WebFrame yet');
    },
    removeWindow(window) {
      const found = windowManager.list().find((w) => w.electronWindow.id === window.id);
      if (found) found.electronWindow.close();
      else window.destroy();
    },
  });

  const loadedExtensions: LoadedExtensionInfo[] = [];
  const nativeMessagingBridge = await installExperimentalNativeMessagingBridge({
    nativeMessaging: opts.nativeMessaging,
    loadedExtensions,
    session,
    patchExtensionActions: true,
    logger,
  });

  loadedExtensions.push(...await loadWebframeExtensions({
    session,
    sessionSource: sessionArg,
    extensions: opts.extensions,
    diagnostics: extensionDiagnostics,
    logger,
  }));

  tabManager = new TabManager({
    tabStore: opts.tabStore,
    historyStore: opts.historyStore,
    bus,
    session,
    tabUserAgent: opts.tabUserAgent,
    tabPreload: opts.tabPreload ?? defaultTabPreloadPath(),
    logger,
    registerCaller: (wcId, tabId) => registry.registerTab(wcId, tabId),
    unregisterCaller: (wcId) => registry.unregister(wcId),
    extensionRuntime: chromeExtensionRuntime,
    getElectronWindow: (windowId) => windowManager.get(windowId)?.electronWindow,
    getWindowLayout: (windowId) => {
      const w = windowManager.get(windowId);
      if (!w) return undefined;
      return {
        bounds: w.bounds,
        slots: w.slots,
        contentView: w.electronWindow.contentView,
      };
    },
    insertTabView: (windowId, view) => windowManager.insertTabView(windowId, view),
    attachTabToWindow: (windowId, tabId) => windowManager.attachTab(windowId, tabId),
    detachTabFromWindow: (windowId, tabId) => windowManager.detachTab(windowId, tabId),
  });

  overlayManager = new OverlayManager({
    bus,
    session,
    overlayPreload: opts.overlayPreload,
    registerCaller: (wcId, oId, wId) => registry.registerOverlay(wcId, oId, wId),
    unregisterCaller: (wcId) => registry.unregister(wcId),
    getWindowLayout: (windowId) => {
      const w = windowManager.get(windowId);
      if (!w) return undefined;
      return {
        bounds: w.bounds,
        slots: w.slots,
        contentView: w.electronWindow.contentView,
      };
    },
    insertOverlayView: (windowId, view) => windowManager.insertOverlayView(windowId, view),
    reorderOverlayViews: (windowId) => windowManager.reorderOverlayViews(windowId),
    attachOverlayToWindow: (windowId, oId) => windowManager.attachOverlay(windowId, oId),
    detachOverlayFromWindow: (windowId, oId) => windowManager.detachOverlay(windowId, oId),
    logger,
  });

  windowManager = new WindowManager({
    bus,
    tabs: tabManager,
    overlays: overlayManager,
    session,
    registerChromeCaller: (wcId, wId) => registry.registerChrome(wcId, wId),
    unregisterCaller: (wcId) => registry.unregister(wcId),
    defaultChromePreload: defaultChromePreloadPath(),
  });

  await tabManager.hydrate();

  const router = createRouter({
    windows: windowManager,
    tabs: tabManager,
    overlays: overlayManager,
    historyStore: opts.historyStore,
    bus,
  });

  const createCaller = createCallerFactory(router);
  const caller = createCaller({ caller: { kind: 'main' } });

  const bridge = new Bridge({ router, createCaller, registry, logger });

  // whoami handler — renderer preload uses it to learn its own Caller identity
  ipcMain.handle('webframe/whoami', (event) => registry.get(event.sender.id));

  const handles = new Map<string, WindowHandle>();

  const app: WebframeApp = {
    router,
    caller,
    windows: {
      async create(options) {
        const handle = await windowManager.create(options);
        handles.set(handle.id, handle);
        handle.electronWindow.on('closed', () => handles.delete(handle.id));
        return handle;
      },
      get: (id) => handles.get(id),
      list: () => Array.from(handles.values()),
    },
    tabs: {
      getWebContents: (tabId) => tabManager.getWebContents(tabId),
    },
    extensions: {
      async triggerAction(extensionId, options = {}) {
        const wc = options.tabId ? tabManager.getWebContents(options.tabId) : undefined;
        const win = wc ? findElectronWindowForTab(windowManager, tabManager, wc) : undefined;
        if (chromeExtensionRuntime && wc && win) {
          await chromeExtensionRuntime.triggerAction(extensionId, wc, win.electronWindow);
          return;
        }
        await nativeMessagingBridge.triggerAction(extensionId, {
          ...options,
          tab: options.tab ?? (wc ? {
            id: wc.id,
            url: wc.getURL(),
            title: wc.getTitle(),
            active: true,
          } : undefined),
        });
      },
    },
    async stop() {
      try {
        await overlayManager.shutdown();
      } catch (e) {
        logger.warn('overlayManager.shutdown failed', e);
      }
      try {
        await tabManager.shutdown();
      } catch (e) {
        logger.warn('tabManager.shutdown failed', e);
      }
      try {
        await windowManager.shutdown();
      } catch (e) {
        logger.warn('windowManager.shutdown failed', e);
      }
      bridge.dispose();
      nativeMessagingBridge.dispose();
      try {
        ipcMain.removeHandler('webframe/whoami');
      } catch {
        // ignore
      }
    },
    _debug: {
      subCount: (wcId) => bridge.subCount(wcId),
      bridge,
      extensions: loadedExtensions,
      extensionDiagnostics: () => collectExtensionDebugInfo(session, extensionDiagnostics),
      extensionPages: () =>
        webContents
          .getAllWebContents()
          .map((wc) => wc.getURL())
          .filter((url) => url.startsWith('chrome-extension://')),
    },
  };

  return app;
}
