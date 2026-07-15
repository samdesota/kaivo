import { randomUUID } from 'node:crypto';
import { WebContentsView, type Session } from 'electron';
import type { EventBus } from './bus';
import { resolveAnchor } from './layout';
import type { Anchor, OverlayInfo } from './types';
import { WebframeError } from './types';

const HIDDEN_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };

export type OverlayCallerRegistrar = (wcId: number, overlayId: string, windowId: string) => void;
export type OverlayCallerUnregistrar = (wcId: number) => void;

export class Overlay {
  id: string;
  windowId: string | null;
  url: string;
  placement: Anchor | null;
  view: WebContentsView;
  transparent: boolean;
  clickThrough: boolean;
  zIndex = 0;

  constructor(
    id: string,
    windowId: string | null,
    url: string,
    placement: Anchor | null,
    view: WebContentsView,
    transparent: boolean,
    clickThrough: boolean,
  ) {
    this.id = id;
    this.windowId = windowId;
    this.url = url;
    this.placement = placement;
    this.view = view;
    this.transparent = transparent;
    this.clickThrough = clickThrough;
  }

  toInfo(): OverlayInfo {
    return {
      id: this.id,
      windowId: this.windowId,
      url: this.url,
      placement: this.placement,
      zIndex: this.zIndex,
    };
  }
}

export type OverlayManagerDeps = {
  bus: EventBus;
  session: Session;
  overlayPreload?: string;
  registerCaller: OverlayCallerRegistrar;
  unregisterCaller: OverlayCallerUnregistrar;
  getWindowLayout: (windowId: string) => { bounds: { x: number; y: number; w: number; h: number }; slots: { name: string; rect: { x: number; y: number; w: number; h: number } }[]; contentView: Electron.View } | undefined;
  insertOverlayView: (windowId: string, view: Electron.View) => void;
  reorderOverlayViews: (windowId: string) => void;
  attachOverlayToWindow: (windowId: string, overlayId: string) => void;
  detachOverlayFromWindow: (windowId: string, overlayId: string) => void;
  logger: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
};

export class OverlayManager {
  private overlays = new Map<string, Overlay>();

  constructor(private deps: OverlayManagerDeps) {}

  get(overlayId: string): Overlay | undefined {
    return this.overlays.get(overlayId);
  }

  listInfo(windowId?: string): OverlayInfo[] {
    const rows: OverlayInfo[] = [];
    for (const o of this.overlays.values()) {
      if (windowId !== undefined && o.windowId !== windowId) continue;
      rows.push(o.toInfo());
    }
    rows.sort((a, b) => a.zIndex - b.zIndex);
    return rows;
  }

  create(opts: {
    windowId: string;
    placement: Anchor;
    url: string;
    transparent?: boolean;
    clickThrough?: boolean;
    preload?: string;
  }): OverlayInfo {
    const overlay = this.createDetached(opts);
    return this.attach(overlay.id, opts.windowId, opts.placement);
  }

  createDetached(opts: {
    url: string;
    transparent?: boolean;
    clickThrough?: boolean;
    preload?: string;
  }): OverlayInfo {
    const id = randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        session: this.deps.session,
        preload: opts.preload ?? this.deps.overlayPreload,
        sandbox: false,
        contextIsolation: true,
        transparent: opts.transparent ?? false,
      },
    });
    if (opts.transparent) {
      try {
        view.setBackgroundColor('#00000000');
      } catch {
        // ignore
      }
    }
    const overlay = new Overlay(
      id,
      null,
      opts.url,
      null,
      view,
      opts.transparent ?? false,
      opts.clickThrough ?? false,
    );
    this.overlays.set(id, overlay);

    view.webContents.loadURL(opts.url).catch((e) => {
      this.deps.logger.warn(`Overlay ${id} loadURL failed`, e);
    });

    return overlay.toInfo();
  }

  attach(overlayId: string, windowId: string, placement: Anchor): OverlayInfo {
    const overlay = this.overlays.get(overlayId);
    if (!overlay) throw new WebframeError('OVERLAY_NOT_FOUND', `Overlay ${overlayId} not found`);
    const layout = this.deps.getWindowLayout(windowId);
    if (!layout) throw new WebframeError('WINDOW_NOT_FOUND', `Window ${windowId} not found`);

    if (overlay.windowId && overlay.windowId !== windowId) this.detach(overlayId);
    overlay.windowId = windowId;
    overlay.placement = placement;
    const existing = Array.from(this.overlays.values()).filter(
      (o) => o.windowId === windowId && o.id !== overlay.id,
    );
    overlay.zIndex = existing.length;

    const rect = resolveAnchor(placement, layout.bounds, layout.slots);
    overlay.view.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    this.deps.attachOverlayToWindow(windowId, overlayId);
    this.deps.registerCaller(overlay.view.webContents.id, overlayId, windowId);
    this.deps.insertOverlayView(windowId, overlay.view);
    this.deps.bus.emit('overlay:change', { overlayId, windowId });
    return overlay.toInfo();
  }

  detach(overlayId: string): OverlayInfo | null {
    const overlay = this.overlays.get(overlayId);
    if (!overlay) return null;
    const windowId = overlay.windowId;
    if (!windowId) return overlay.toInfo();
    const layout = this.deps.getWindowLayout(windowId);
    if (layout) {
      try {
        layout.contentView.removeChildView(overlay.view);
      } catch {
        // ignore
      }
    }
    this.deps.unregisterCaller(overlay.view.webContents.id);
    overlay.windowId = null;
    overlay.placement = null;
    overlay.zIndex = 0;
    this.deps.detachOverlayFromWindow(windowId, overlayId);
    const remaining = Array.from(this.overlays.values())
      .filter((x) => x.windowId === windowId)
      .sort((a, b) => a.zIndex - b.zIndex);
    remaining.forEach((x, i) => (x.zIndex = i));
    this.deps.bus.emit('overlay:change', { overlayId, windowId });
    return overlay.toInfo();
  }

  close(overlayId: string): void {
    const o = this.overlays.get(overlayId);
    if (!o) return;
    const windowId = o.windowId;
    const layout = windowId ? this.deps.getWindowLayout(windowId) : undefined;
    if (layout) {
      try {
        layout.contentView.removeChildView(o.view);
      } catch {
        // ignore
      }
    }
    this.deps.unregisterCaller(o.view.webContents.id);
    try {
      if (!o.view.webContents.isDestroyed()) o.view.webContents.close();
    } catch {
      // ignore
    }
    this.overlays.delete(overlayId);
    if (!windowId) return;
    this.deps.detachOverlayFromWindow(windowId, overlayId);
    // Renormalize zIndex values for the window
    const remaining = Array.from(this.overlays.values())
      .filter((x) => x.windowId === windowId)
      .sort((a, b) => a.zIndex - b.zIndex);
    remaining.forEach((x, i) => (x.zIndex = i));
    this.deps.bus.emit('overlay:change', { overlayId, windowId });
  }

  move(overlayId: string, placement: Anchor): void {
    const o = this.overlays.get(overlayId);
    if (!o) throw new WebframeError('OVERLAY_NOT_FOUND', `Overlay ${overlayId} not found`);
    if (!o.windowId) throw new WebframeError('OVERLAY_DETACHED', `Overlay ${overlayId} is detached`);
    const layout = this.deps.getWindowLayout(o.windowId);
    if (!layout) return;
    const rect = resolveAnchor(placement, layout.bounds, layout.slots);
    o.placement = placement;
    o.view.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  }

  setZ(overlayId: string, index: number): void {
    const o = this.overlays.get(overlayId);
    if (!o) throw new WebframeError('OVERLAY_NOT_FOUND', `Overlay ${overlayId} not found`);
    if (!o.windowId) throw new WebframeError('OVERLAY_DETACHED', `Overlay ${overlayId} is detached`);
    const peers = Array.from(this.overlays.values())
      .filter((x) => x.windowId === o.windowId)
      .sort((a, b) => a.zIndex - b.zIndex);
    const clamped = Math.max(0, Math.min(index, peers.length - 1));
    const without = peers.filter((x) => x.id !== o.id);
    without.splice(clamped, 0, o);
    without.forEach((x, i) => (x.zIndex = i));
    this.deps.reorderOverlayViews(o.windowId);
  }

  rebindToLayout(windowId: string): void {
    const layout = this.deps.getWindowLayout(windowId);
    if (!layout) return;
    for (const o of this.overlays.values()) {
      if (o.windowId !== windowId) continue;
      if (!o.placement) continue;
      try {
        const rect = resolveAnchor(o.placement, layout.bounds, layout.slots);
        o.view.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
      } catch (error) {
        if (error instanceof WebframeError && error.code === 'SLOT_NOT_FOUND') {
          o.view.setBounds(HIDDEN_BOUNDS);
          this.deps.logger.warn('webframe overlay placement slot missing during layout rebind', {
            overlayId: o.id,
            windowId,
            placement: o.placement,
          });
          continue;
        }
        throw error;
      }
    }
  }

  /** Overlay views in draw order (low zIndex first, high zIndex on top) for a window. */
  orderedForWindow(windowId: string): Overlay[] {
    return Array.from(this.overlays.values())
      .filter((o) => o.windowId === windowId)
      .sort((a, b) => a.zIndex - b.zIndex);
  }

  closeAllForWindow(windowId: string): void {
    for (const o of Array.from(this.overlays.values())) {
      if (o.windowId === windowId) this.close(o.id);
    }
  }

  async shutdown(): Promise<void> {
    for (const o of Array.from(this.overlays.values())) {
      this.close(o.id);
    }
  }
}
