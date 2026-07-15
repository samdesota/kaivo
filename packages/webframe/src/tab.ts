import { randomUUID } from 'node:crypto';
import {
  BrowserWindow,
  WebContentsView,
  type BaseWindow,
  type BrowserWindowConstructorOptions,
  type HandlerDetails,
  type Session,
  type WebContents,
  type WindowOpenHandlerResponse,
} from 'electron';
import type { EventBus } from './bus';
import { resolveAnchor } from './layout';
import type { HistoryStore, TabStore } from './stores/types';
import type { Anchor, TabRecord } from './types';
import { WebframeError } from './types';
import { selectFaviconCandidate } from './favicon';

const HIDDEN_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };
const VISUAL_ZOOM_MIN = 1;
const VISUAL_ZOOM_MAX = 3;

export type TabCallerRegistrar = (wcId: number, tabId: string) => void;
export type TabCallerUnregistrar = (wcId: number) => void;

export class Tab {
  id: string;
  record: TabRecord;
  view: WebContentsView | null = null;
  popupWindow: BrowserWindow | null = null;
  popupWebContentsId: number | null = null;
  openerWindowId: string | null = null;
  attachedWindowId: string | null = null;
  placement: Anchor | null = null;
  active = false;

  constructor(record: TabRecord) {
    this.id = record.id;
    this.record = record;
  }
}

export type TabManagerDeps = {
  tabStore: TabStore;
  historyStore: HistoryStore;
  bus: EventBus;
  session: Session;
  tabUserAgent?: string;
  tabPreload?: string;
  logger: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  registerCaller: TabCallerRegistrar;
  unregisterCaller: TabCallerUnregistrar;
  extensionRuntime?: {
    addTab(tab: WebContents, window: BaseWindow): void;
    removeTab(tab: WebContents): void;
    selectTab(tab: WebContents): void;
  };
  getElectronWindow: (windowId: string) => BaseWindow | undefined;
  /** Resolves window bounds + slots for anchor resolution. */
  getWindowLayout: (windowId: string) => { bounds: { x: number; y: number; w: number; h: number }; slots: { name: string; rect: { x: number; y: number; w: number; h: number } }[]; contentView: Electron.View } | undefined;
  /** Insert or move a tab view below any currently visible overlays. */
  insertTabView: (windowId: string, view: Electron.View) => void;
  /** Track this tab in the window's id list (attach/detach). */
  attachTabToWindow: (windowId: string, tabId: string) => void;
  detachTabFromWindow: (windowId: string, tabId: string) => void;
};

export class TabManager {
  private tabs = new Map<string, Tab>();
  private ownerKeys = new Map<string, string>();

  constructor(private deps: TabManagerDeps) {}

  get(tabId: string): Tab | undefined {
    return this.tabs.get(tabId);
  }

  all(): Tab[] {
    return Array.from(this.tabs.values());
  }

  getWebContents(tabId: string): WebContents | undefined {
    const wc = this.webContentsFor(this.tabs.get(tabId));
    if (!wc || wc.isDestroyed()) return undefined;
    return wc;
  }

  getTabIdForWebContents(wc: WebContents): string | undefined {
    return this.all().find((tab) => this.webContentsFor(tab)?.id === wc.id)?.id;
  }

  listRecords(windowId?: string): TabRecord[] {
    const tabs = Array.from(this.tabs.values()).filter((t) =>
      windowId === undefined ? true : t.attachedWindowId === windowId || t.openerWindowId === windowId,
    );
    return tabs.map((t) => ({ ...t.record }));
  }

  async hydrate(): Promise<void> {
    const stored = await this.deps.tabStore.list();
    for (const rec of stored) {
      if (!this.tabs.has(rec.id)) {
        const tab = new Tab({ ...rec, presentation: rec.presentation ?? 'embedded' });
        this.tabs.set(rec.id, tab);
        if (rec.ownerKey) this.ownerKeys.set(rec.ownerKey, rec.id);
      }
    }
  }

  async create(opts: {
    url: string;
    windowId?: string;
    placement?: Anchor;
    active?: boolean;
    ownerKey?: string;
    stateStoreKey?: string;
    openerTabId?: string;
  }): Promise<TabRecord> {
    const owned = opts.ownerKey ? this.tabForOwnerKey(opts.ownerKey) : undefined;
    if (owned) {
      if (opts.windowId) {
        if (!opts.placement) {
          throw new WebframeError(
            'PLACEMENT_REQUIRED',
            'placement is required when windowId is supplied',
          );
        }
        this.move(owned.id, opts.windowId, opts.placement);
        if (opts.active) this.setActive(owned.id, opts.windowId);
      }
      return { ...owned.record };
    }

    const now = Date.now();
    const record: TabRecord = {
      id: randomUUID(),
      ownerKey: opts.ownerKey,
      url: opts.url,
      title: '',
      createdAt: now,
      lastVisitedAt: now,
      stateStoreKey: opts.stateStoreKey,
      presentation: 'embedded',
      openerTabId: opts.openerTabId,
    };
    const tab = new Tab(record);
    this.tabs.set(tab.id, tab);
    if (opts.ownerKey) this.ownerKeys.set(opts.ownerKey, tab.id);
    await this.deps.tabStore.put(record);

    if (opts.windowId) {
      if (!opts.placement) {
        throw new WebframeError(
          'PLACEMENT_REQUIRED',
          'placement is required when windowId is supplied',
        );
      }
      this.mount(tab, opts.windowId, opts.placement, opts.active ?? false);
    }
    this.deps.bus.emit('tab:created', {
      tab: { ...record },
      windowId: opts.windowId ?? null,
      openerTabId: opts.openerTabId ?? null,
    });
    return { ...record };
  }

  async close(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (tab.popupWindow) {
      this.destroyPopup(tab);
    } else if (tab.attachedWindowId) {
      this.unmount(tab, /*destroyView*/ true);
    } else if (tab.view) {
      this.destroyView(tab);
    }
    this.tabs.delete(tabId);
    if (tab.record.ownerKey) this.ownerKeys.delete(tab.record.ownerKey);
    await this.deps.tabStore.delete(tabId);
    await this.deps.historyStore.deleteFor(tabId);
  }

  async detach(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new WebframeError('TAB_NOT_FOUND', `Tab ${tabId} not found`);
    if (!tab.attachedWindowId) return;
    this.unmount(tab, /*destroyView*/ true);
  }

  move(tabId: string, windowId: string, placement: Anchor): void {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new WebframeError('TAB_NOT_FOUND', `Tab ${tabId} not found`);

    const from = tab.attachedWindowId ? { windowId: tab.attachedWindowId } : null;

    if (tab.popupWindow) {
      throw new WebframeError('UNSUPPORTED_OPERATION', 'popup tabs cannot be moved into embedded windows');
    }

    if (tab.view && tab.attachedWindowId) {
      const srcLayout = this.deps.getWindowLayout(tab.attachedWindowId);
      if (srcLayout) {
        try {
          srcLayout.contentView.removeChildView(tab.view);
        } catch {
          // ignore
        }
      }
      this.deps.detachTabFromWindow(tab.attachedWindowId, tab.id);
    }

    const dstLayout = this.deps.getWindowLayout(windowId);
    if (!dstLayout) throw new WebframeError('WINDOW_NOT_FOUND', `Window ${windowId} not found`);
    if (!tab.view) {
      tab.record.presentation = 'embedded';
      tab.view = this.createView(tab);
      this.loadUrl(tab);
    }
    const rect = resolveAnchor(placement, dstLayout.bounds, dstLayout.slots);
    tab.view.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    tab.attachedWindowId = windowId;
    tab.openerWindowId = null;
    tab.placement = placement;
    this.deps.attachTabToWindow(windowId, tab.id);
    this.deps.insertTabView(windowId, tab.view);
    this.registerExtensionTab(tab);
    if (tab.active) this.deps.extensionRuntime?.selectTab(tab.view.webContents);
    this.deps.bus.emit('tab:moved', { tabId: tab.id, from, to: { windowId } });
  }

  setActive(tabId: string, windowId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new WebframeError('TAB_NOT_FOUND', `Tab ${tabId} not found`);
    if (tab.popupWindow) {
      tab.popupWindow.focus();
      return;
    }
    if (tab.attachedWindowId !== windowId) {
      throw new WebframeError(
        'TAB_NOT_IN_WINDOW',
        `Tab ${tabId} is not attached to window ${windowId}`,
      );
    }
    for (const other of this.tabs.values()) {
      if (other.attachedWindowId === windowId) {
        const shouldBeActive = other.id === tabId;
        other.active = shouldBeActive;
        if (other.view) other.view.setVisible(shouldBeActive);
      }
    }
    if (tab.view) this.deps.insertTabView(windowId, tab.view);
    if (tab.view) this.deps.extensionRuntime?.selectTab(tab.view.webContents);
  }

  rebindToLayout(windowId: string): void {
    const layout = this.deps.getWindowLayout(windowId);
    if (!layout) return;
    for (const tab of this.tabs.values()) {
      if (tab.attachedWindowId === windowId && tab.view && tab.placement) {
        try {
          const rect = resolveAnchor(tab.placement, layout.bounds, layout.slots);
          tab.view.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
        } catch (error) {
          if (error instanceof WebframeError && error.code === 'SLOT_NOT_FOUND') {
            tab.view.setBounds(HIDDEN_BOUNDS);
            this.deps.logger.warn('webframe tab placement slot missing during layout rebind', {
              tabId: tab.id,
              windowId,
              placement: tab.placement,
            });
            continue;
          }
          throw error;
        }
      }
    }
  }

  detachAllFromWindow(windowId: string): string[] {
    const detached: string[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.attachedWindowId === windowId) {
        this.unmount(tab, /*destroyView*/ true);
        detached.push(tab.id);
      }
    }
    return detached;
  }

  private mount(tab: Tab, windowId: string, placement: Anchor, active: boolean): void {
    const layout = this.deps.getWindowLayout(windowId);
    if (!layout) throw new WebframeError('WINDOW_NOT_FOUND', `Window ${windowId} not found`);
    if (!tab.view) tab.view = this.createView(tab);
    const rect = resolveAnchor(placement, layout.bounds, layout.slots);
    tab.view.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    tab.attachedWindowId = windowId;
    tab.placement = placement;
    tab.active = active;
    tab.view.setVisible(active);
    this.deps.attachTabToWindow(windowId, tab.id);
    this.deps.insertTabView(windowId, tab.view);
    this.registerExtensionTab(tab);

    this.loadUrl(tab);

    if (active) {
      for (const other of this.tabs.values()) {
        if (other !== tab && other.attachedWindowId === windowId) {
          other.active = false;
          if (other.view) other.view.setVisible(false);
        }
      }
      this.deps.extensionRuntime?.selectTab(tab.view.webContents);
    }
    this.deps.bus.emit('tab:moved', { tabId: tab.id, from: null, to: { windowId } });
  }

  private tabForOwnerKey(ownerKey: string): Tab | undefined {
    const tabId = this.ownerKeys.get(ownerKey);
    if (!tabId) return undefined;
    const tab = this.tabs.get(tabId);
    if (tab) return tab;
    this.ownerKeys.delete(ownerKey);
    return undefined;
  }

  private unmount(tab: Tab, destroyView: boolean): void {
    const windowId = tab.attachedWindowId;
    if (!windowId) return;
    const layout = this.deps.getWindowLayout(windowId);
    if (layout && tab.view) {
      try {
        layout.contentView.removeChildView(tab.view);
      } catch {
        // ignore
      }
    }
    if (tab.view) this.deps.extensionRuntime?.removeTab(tab.view.webContents);
    this.deps.detachTabFromWindow(windowId, tab.id);
    tab.attachedWindowId = null;
    tab.placement = null;
    tab.active = false;
    if (destroyView) this.destroyView(tab);
    this.deps.bus.emit('tab:moved', { tabId: tab.id, from: { windowId }, to: null });
  }

  private destroyView(tab: Tab): void {
    if (!tab.view) return;
    const wc = tab.view.webContents;
    this.deps.extensionRuntime?.removeTab(wc);
    this.deps.unregisterCaller(wc.id);
    try {
      if (!wc.isDestroyed()) wc.close();
    } catch {
      // ignore
    }
    tab.view = null;
  }

  private destroyPopup(tab: Tab): void {
    if (!tab.popupWindow) return;
    const win = tab.popupWindow;
    const wcId = tab.popupWebContentsId;
    const wc = this.webContentsFor(tab);
    tab.popupWindow = null;
    tab.popupWebContentsId = null;
    if (wc) this.deps.extensionRuntime?.removeTab(wc);
    if (wcId !== null) this.deps.unregisterCaller(wcId);
    try {
      if (!win.isDestroyed()) win.close();
    } catch {
      // ignore
    }
  }

  private createView(tab: Tab): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        session: this.deps.session,
        preload: this.deps.tabPreload,
        sandbox: false,
        contextIsolation: true,
      },
    });
    const wc = view.webContents;
    if (this.deps.tabUserAgent) wc.setUserAgent(this.deps.tabUserAgent);
    this.deps.registerCaller(wc.id, tab.id);
    this.installWebContentsEvents(tab, wc);
    return view;
  }

  private registerExtensionTab(tab: Tab): void {
    if (!tab.view || !tab.attachedWindowId) return;
    const win = this.deps.getElectronWindow(tab.attachedWindowId);
    if (!win) return;
    this.deps.extensionRuntime?.addTab(tab.view.webContents, win);
  }

  private handleWindowOpen(opener: Tab, details: HandlerDetails): WindowOpenHandlerResponse {
    if (shouldOpenAsPopup(details)) return this.createPopupFromOpener(opener, details);

    void this.createFromOpener(opener, details.url).catch((e) => {
      this.deps.logger.warn(`Tab ${opener.id} popup failed`, e);
    });
    return { action: 'deny' };
  }

  private createPopupFromOpener(opener: Tab, details: HandlerDetails): WindowOpenHandlerResponse {
    return {
      action: 'allow',
      createWindow: (options) => {
        const tab = this.createPopupTab(opener, details, options);
        const wc = this.webContentsFor(tab);
        if (!wc) throw new Error('popup WebContents missing after creation');
        return wc;
      },
    };
  }

  private createPopupTab(opener: Tab, details: HandlerDetails, options: BrowserWindowConstructorOptions): Tab {
    const now = Date.now();
    const record: TabRecord = {
      id: randomUUID(),
      url: details.url,
      title: '',
      createdAt: now,
      lastVisitedAt: now,
      presentation: 'popup',
      openerTabId: opener.id,
    };
    const tab = new Tab(record);
    tab.openerWindowId = opener.attachedWindowId ?? opener.openerWindowId;
    const popupWindow = new BrowserWindow({
      ...options,
      webPreferences: {
        ...(options.webPreferences ?? {}),
        session: options.webPreferences?.session ?? this.deps.session,
        preload: options.webPreferences?.preload ?? this.deps.tabPreload,
        sandbox: false,
        contextIsolation: true,
      },
    });
    tab.popupWindow = popupWindow;
    const popupWebContents = popupWindow.webContents;
    if (this.deps.tabUserAgent) popupWebContents.setUserAgent(this.deps.tabUserAgent);
    this.tabs.set(tab.id, tab);
    const popupWcId = popupWebContents.id;
    tab.popupWebContentsId = popupWcId;
    this.deps.registerCaller(popupWcId, tab.id);
    this.installWebContentsEvents(tab, popupWebContents);
    this.deps.extensionRuntime?.addTab(popupWebContents, popupWindow);
    this.deps.extensionRuntime?.selectTab(popupWebContents);
    popupWindow.on('closed', () => {
      this.deps.unregisterCaller(popupWcId);
      if (tab.popupWindow === popupWindow) tab.popupWindow = null;
      if (tab.popupWebContentsId === popupWcId) tab.popupWebContentsId = null;
      this.tabs.delete(tab.id);
    });
    this.deps.bus.emit('tab:created', {
      tab: { ...record },
      windowId: tab.openerWindowId,
      openerTabId: opener.id,
    });
    return tab;
  }

  private installWebContentsEvents(tab: Tab, wc: WebContents): void {
    wc.setWindowOpenHandler((details) => this.handleWindowOpen(tab, details));
    this.enableNativePinchZoom(wc);

    const persist = async () => {
      tab.record = { ...tab.record, lastVisitedAt: Date.now() };
      if (tab.record.presentation === 'popup') return;
      await this.deps.tabStore.put(tab.record).catch((e) => {
        this.deps.logger.warn('tabStore.put failed', e);
      });
    };

    wc.on('page-title-updated', (_evt, title) => {
      tab.record.title = title;
      void persist();
      this.deps.bus.emit('tab:change', { tabId: tab.id, patch: { title } });
    });
    wc.on('page-favicon-updated', (_evt, favicons) => {
      const favicon = selectFaviconCandidate({
        pageUrl: tab.record.url,
        candidates: favicons,
        previous: tab.record.favicon,
      });
      if (!favicon) return;
      tab.record.favicon = favicon;
      void persist();
      this.deps.bus.emit('tab:change', { tabId: tab.id, patch: { favicon } });
    });
    wc.on('did-navigate', (_evt, url) => {
      tab.record.url = url;
      void persist();
      this.deps.bus.emit('tab:change', { tabId: tab.id, patch: { url } });
      const entry = {
        id: randomUUID(),
        tabId: tab.id,
        url,
        title: tab.record.title,
        visitedAt: Date.now(),
      };
      this.deps.historyStore.append(entry).catch((e) => {
        this.deps.logger.warn('historyStore.append failed', e);
      });
    });
    wc.on('did-navigate-in-page', (_evt, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.record.url = url;
      void persist();
      this.deps.bus.emit('tab:change', { tabId: tab.id, patch: { url } });
    });
    wc.on('did-start-loading', () => {
      this.deps.bus.emit('navigation:lifecycle', {
        tabId: tab.id,
        phase: 'loading',
        url: tab.record.url,
      });
    });
    wc.on('did-finish-load', () => {
      this.deps.bus.emit('navigation:lifecycle', {
        tabId: tab.id,
        phase: 'loaded',
        url: tab.record.url,
      });
    });
    wc.on('did-fail-load', (_evt, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      this.deps.logger.warn('tab did-fail-load', {
        tabId: tab.id,
        errorCode,
        errorDescription,
        url: validatedURL,
      });
      this.deps.bus.emit('navigation:lifecycle', {
        tabId: tab.id,
        phase: 'failed',
        url: validatedURL,
        error: `${errorCode}: ${errorDescription}`,
      });
    });
    wc.on('render-process-gone', (_evt, details) => {
      this.deps.logger.warn('tab render-process-gone', { tabId: tab.id, url: tab.record.url, details });
      this.deps.bus.emit('navigation:lifecycle', {
        tabId: tab.id,
        phase: 'crashed',
        url: tab.record.url,
        error: details.reason,
      });
    });
    wc.on('console-message', (_evt, level, message, line, sourceId) => {
      if (level < 2 && !sourceId.startsWith('chrome-extension://')) return;
      const levelName = ['verbose', 'info', 'warn', 'error'][level] ?? String(level);
      this.deps.logger.warn('tab console', {
        tabId: tab.id,
        level: levelName,
        message,
        sourceId,
        line,
        url: tab.record.url,
      });
    });
  }

  private enableNativePinchZoom(wc: WebContents): void {
    const apply = () => {
      if (wc.isDestroyed()) return;
      void wc.setVisualZoomLevelLimits(VISUAL_ZOOM_MIN, VISUAL_ZOOM_MAX).catch((e) => {
        this.deps.logger.warn('setVisualZoomLevelLimits failed', e);
      });
    };

    apply();
    wc.on('did-finish-load', apply);
    wc.on('did-navigate', apply);
  }

  private webContentsFor(tab: Tab | undefined): WebContents | undefined {
    if (!tab) return undefined;
    try {
      if (tab.view) {
        const wc = tab.view.webContents;
        return wc.isDestroyed() ? undefined : wc;
      }
      if (!tab.popupWindow || tab.popupWindow.isDestroyed()) return undefined;
      const wc = tab.popupWindow.webContents;
      return wc.isDestroyed() ? undefined : wc;
    } catch {
      return undefined;
    }
  }

  private async createFromOpener(opener: Tab, url: string): Promise<void> {
    if (!opener.attachedWindowId || !opener.placement) return;
    await this.create({
      url,
      windowId: opener.attachedWindowId,
      placement: opener.placement,
      active: true,
      openerTabId: opener.id,
    });
  }

  private loadUrl(tab: Tab): void {
    const wc = this.webContentsFor(tab);
    if (!wc) return;
    wc.loadURL(tab.record.url).catch((e) => {
      this.deps.logger.warn(`Tab ${tab.id} loadURL failed`, e);
    });
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const tab = this.requireTab(tabId);
    tab.record.url = url;
    if (tab.record.presentation !== 'popup') await this.deps.tabStore.put(tab.record);
    await this.webContentsFor(tab)?.loadURL(url);
  }

  back(tabId: string): void {
    const wc = this.webContentsFor(this.requireTab(tabId));
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(tabId: string): void {
    const wc = this.webContentsFor(this.requireTab(tabId));
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(tabId: string, ignoreCache: boolean): void {
    const wc = this.webContentsFor(this.requireTab(tabId));
    if (!wc) return;
    if (ignoreCache) wc.reloadIgnoringCache();
    else wc.reload();
  }

  stopLoading(tabId: string): void {
    this.webContentsFor(this.requireTab(tabId))?.stop();
  }

  private requireTab(tabId: string): Tab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new WebframeError('TAB_NOT_FOUND', `Tab ${tabId} not found`);
    return tab;
  }

  async shutdown(): Promise<void> {
    for (const tab of this.tabs.values()) {
      if (tab.popupWindow) this.destroyPopup(tab);
      if (tab.view) this.destroyView(tab);
    }
    this.tabs.clear();
  }
}

function shouldOpenAsPopup(details: HandlerDetails): boolean {
  const frameName = details.frameName.trim().toLowerCase();
  if (frameName && !isReservedFrameName(frameName)) return true;

  return parseWindowFeatureNames(details.features).some((feature) => !isNonPopupWindowFeature(feature));
}

function isReservedFrameName(frameName: string): boolean {
  return frameName === '_blank' || frameName === '_self' || frameName === '_parent' || frameName === '_top';
}

function parseWindowFeatureNames(features: string): string[] {
  return features
    .split(',')
    .map((feature) => feature.trim().toLowerCase().split('=', 1)[0] ?? '')
    .filter(Boolean);
}

function isNonPopupWindowFeature(feature: string): boolean {
  return feature === 'noopener' || feature === 'noreferrer';
}
