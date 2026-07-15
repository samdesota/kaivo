import { randomUUID } from 'node:crypto';
import { BrowserWindow, type BrowserWindowConstructorOptions, type Session } from 'electron';
import type { EventBus } from './bus';
import type { OverlayManager } from './overlay';
import type { TabManager } from './tab';
import type { Rect, Slot, WindowInfo } from './types';
import { WebframeError } from './types';

export type WindowOptions = {
  chromeUrl: string;
  chromePreload?: string;
  electronWindow?: BrowserWindowConstructorOptions;
  initialSlots?: Slot[];
};

export type WindowHandle = {
  id: string;
  electronWindow: BrowserWindow;
  close: () => Promise<void>;
};

export class WebframeWindow {
  id = randomUUID();
  electronWindow: BrowserWindow;
  slots: Slot[] = [];
  tabIds: string[] = [];
  overlayIds: string[] = [];

  constructor(electronWindow: BrowserWindow, initialSlots: Slot[]) {
    this.electronWindow = electronWindow;
    this.slots = [...initialSlots];
  }

  get bounds(): Rect {
    if (this.electronWindow.isDestroyed()) return { x: 0, y: 0, w: 0, h: 0 };
    const b = this.electronWindow.getContentBounds();
    return { x: 0, y: 0, w: b.width, h: b.height };
  }
}

export type WindowManagerDeps = {
  bus: EventBus;
  tabs: TabManager;
  overlays: OverlayManager;
  session: Session;
  /** Register caller identity for the chrome WebContents on DOMContentLoaded. */
  registerChromeCaller: (wcId: number, windowId: string) => void;
  unregisterCaller: (wcId: number) => void;
  defaultChromePreload: string;
};

export class WindowManager {
  private windows = new Map<string, WebframeWindow>();

  constructor(private deps: WindowManagerDeps) {}

  get(id: string): WebframeWindow | undefined {
    return this.windows.get(id);
  }

  list(): WebframeWindow[] {
    return Array.from(this.windows.values());
  }

  listInfo(): WindowInfo[] {
    return this.list().map((w) => this.toInfo(w));
  }

  toInfo(w: WebframeWindow): WindowInfo {
    return {
      id: w.id,
      bounds: w.bounds,
      slots: w.slots.map((s) => ({ name: s.name, rect: { ...s.rect } })),
      tabIds: [...w.tabIds],
      overlayIds: [...w.overlayIds],
    };
  }

  async create(opts: WindowOptions): Promise<WindowHandle> {
    const preloads = [this.deps.defaultChromePreload];
    if (opts.chromePreload) preloads.push(opts.chromePreload);
    // Electron BrowserWindow accepts only a single preload string; chain by using additional via session.setPreloads is an option, but simpler is to let consumers bundle their preload extending ours. We honor consumer preload when provided.
    const preload = opts.chromePreload ?? this.deps.defaultChromePreload;

    const ebw = new BrowserWindow({
      ...(opts.electronWindow ?? {}),
      webPreferences: {
        ...(opts.electronWindow?.webPreferences ?? {}),
        session: opts.electronWindow?.webPreferences?.session ?? this.deps.session,
        preload,
        contextIsolation: true,
        sandbox: false,
      },
    });
    const win = new WebframeWindow(ebw, opts.initialSlots ?? []);
    this.windows.set(win.id, win);

    this.deps.registerChromeCaller(ebw.webContents.id, win.id);

    await ebw.loadURL(opts.chromeUrl);

    // Emit resize events
    const onResize = () => {
      const b = win.bounds;
      this.deps.bus.emit('window:resize', { windowId: win.id, w: b.w, h: b.h });
      this.deps.tabs.rebindToLayout(win.id);
      this.deps.overlays.rebindToLayout(win.id);
    };
    ebw.on('resize', onResize);
    ebw.on('resized', onResize);

    // Capture the chrome WebContents id before the window is destroyed —
    // accessing `ebw.webContents` after destruction can throw.
    const chromeWcId = ebw.webContents.id;
    ebw.on('closed', () => {
      // Remove from the map first so any cleanup-triggered queries see the
      // window as already gone.
      this.windows.delete(win.id);
      try {
        this.deps.unregisterCaller(chromeWcId);
      } catch {
        // ignore
      }
      try {
        this.deps.overlays.closeAllForWindow(win.id);
      } catch {
        // ignore
      }
      try {
        this.deps.tabs.detachAllFromWindow(win.id);
      } catch {
        // ignore
      }
    });

    return {
      id: win.id,
      electronWindow: ebw,
      close: async () => {
        if (!ebw.isDestroyed()) ebw.close();
      },
    };
  }

  setSlots(windowId: string, slots: Slot[]): void {
    const w = this.windows.get(windowId);
    if (!w) throw new WebframeError('WINDOW_NOT_FOUND', `Window ${windowId} not found`);
    w.slots = slots.map((s) => ({ name: s.name, rect: { ...s.rect } }));
    this.deps.tabs.rebindToLayout(windowId);
    this.deps.overlays.rebindToLayout(windowId);
  }

  attachTab(windowId: string, tabId: string): void {
    const w = this.windows.get(windowId);
    if (!w) return;
    if (!w.tabIds.includes(tabId)) w.tabIds.push(tabId);
  }

  detachTab(windowId: string, tabId: string): void {
    const w = this.windows.get(windowId);
    if (!w) return;
    w.tabIds = w.tabIds.filter((id) => id !== tabId);
  }

  attachOverlay(windowId: string, overlayId: string): void {
    const w = this.windows.get(windowId);
    if (!w) return;
    if (!w.overlayIds.includes(overlayId)) w.overlayIds.push(overlayId);
  }

  detachOverlay(windowId: string, overlayId: string): void {
    const w = this.windows.get(windowId);
    if (!w) return;
    w.overlayIds = w.overlayIds.filter((id) => id !== overlayId);
  }

  insertTabView(windowId: string, view: Electron.View): void {
    const w = this.windows.get(windowId);
    if (!w || w.electronWindow.isDestroyed()) return;
    const contentView = w.electronWindow.contentView;
    try {
      contentView.removeChildView(view);
    } catch {
      // ignore (not yet attached)
    }
    const overlayViews: Electron.View[] = [];
    for (const id of w.overlayIds) {
      const view = this.deps.overlays.get(id)?.view;
      if (view) overlayViews.push(view);
    }
    const firstOverlayIndex = contentView.children.findIndex((child) => overlayViews.includes(child));
    const index = firstOverlayIndex === -1 ? contentView.children.length : firstOverlayIndex;
    contentView.addChildView(view, index);
  }

  insertOverlayView(windowId: string, view: Electron.View): void {
    const w = this.windows.get(windowId);
    if (!w || w.electronWindow.isDestroyed()) return;
    const contentView = w.electronWindow.contentView;
    try {
      contentView.removeChildView(view);
    } catch {
      // ignore (not yet attached)
    }
    contentView.addChildView(view, contentView.children.length);
  }

  reorderOverlayViews(windowId: string): void {
    const w = this.windows.get(windowId);
    if (!w || w.electronWindow.isDestroyed()) return;
    for (const overlay of this.deps.overlays.orderedForWindow(windowId)) {
      this.insertOverlayView(windowId, overlay.view);
    }
  }

  /** Apply the z-order invariant: [hiddenTabs..., activeTab, ...overlays]. */
  reapplyOrder(windowId: string): void {
    const w = this.windows.get(windowId);
    if (!w || w.electronWindow.isDestroyed()) return;

    const desired: Electron.View[] = [];
    const hiddenTabs: Electron.View[] = [];
    let activeTabView: Electron.View | null = null;

    for (const tabId of w.tabIds) {
      const tab = this.deps.tabs.get(tabId);
      if (!tab?.view) continue;
      if (tab.active) activeTabView = tab.view;
      else hiddenTabs.push(tab.view);
    }
    desired.push(...hiddenTabs);
    if (activeTabView) desired.push(activeTabView);

    const orderedOverlays = this.deps.overlays.orderedForWindow(windowId);
    for (const o of orderedOverlays) desired.push(o.view);

    const contentView = w.electronWindow.contentView;
    // Remove views no longer in desired set
    const currentChildren = contentView.children.slice();
    for (const child of currentChildren) {
      if (!desired.includes(child)) {
        try {
          contentView.removeChildView(child);
        } catch {
          // ignore
        }
      }
    }
    // Re-add all in desired order
    for (const child of desired) {
      try {
        contentView.removeChildView(child);
      } catch {
        // ignore (not yet attached)
      }
      contentView.addChildView(child);
    }

  }

  async shutdown(): Promise<void> {
    for (const w of Array.from(this.windows.values())) {
      try {
        if (!w.electronWindow.isDestroyed()) w.electronWindow.close();
      } catch {
        // ignore
      }
    }
    this.windows.clear();
  }
}
