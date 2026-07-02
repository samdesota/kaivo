import { clientLogger } from './client-logger'

export type BrowserSlotUpdate = {
  paneId: string
  rect: { x: number; y: number; width: number; height: number }
}

export type BrowserTabChange = {
  browserTabId: string
  patch: Record<string, unknown>
}

export type BrowserTabCreated = {
  browserTabId: string
  windowId: string | null
  openerBrowserTabId: string | null
  url: string
  title: string
  favicon?: string
  presentation?: 'embedded' | 'popup'
}

export type BrowserTabFocus = {
  browserTabId: string
}

export type BrowserFoundInPage = {
  browserTabId: string
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

export type BrowserApi = {
  isAvailable(): boolean
  getWindowId(): Promise<string>
  listTabs(): Promise<Array<{ browserTabId: string; url?: string; favicon?: string; presentation?: 'embedded' | 'popup' }>>
  createTab(input: { paneId: string; url?: string }): Promise<{ browserTabId: string; favicon?: string }>
  attachTab(input: { paneId: string; browserTabId: string }): Promise<void>
  focusTab(input: { browserTabId: string }): Promise<void>
  navigate(input: { browserTabId: string; url: string }): Promise<void>
  back(input: { browserTabId: string }): Promise<void>
  forward(input: { browserTabId: string }): Promise<void>
  reload(input: { browserTabId: string; ignoreCache?: boolean }): Promise<void>
  openDevTools(input: { browserTabId: string }): Promise<void>
  openOnePassword(input: { browserTabId: string }): Promise<void>
  findInPage(input: { browserTabId: string; text: string; forward?: boolean; findNext?: boolean }): Promise<void>
  stopFindInPage(input: { browserTabId: string; action?: 'clearSelection' | 'keepSelection' | 'activateSelection' }): Promise<void>
  setZoom(input: { browserTabId: string; level: number }): Promise<{ zoomLevel: number }>
  registerTabFocusOwner(input: { browserTabId: string }): void
  getAgentConnections(): Promise<{ browserTabIds: string[] }>
  disconnectAgent(input: { browserTabId: string }): Promise<void>
  closeTab(input: { browserTabId: string }): Promise<void>
  setSlot(input: BrowserSlotUpdate): Promise<void>
  createDetachedOverlay(input: { url: string; transparent?: boolean; clickThrough?: boolean }): Promise<{ overlayId: string }>
  attachOverlay(input: { overlayId: string; placement: { x: number; y: number; w: number; h: number } }): Promise<void>
  focusOverlay(input: { overlayId: string }): Promise<void>
  detachOverlay(input: { overlayId: string }): Promise<void>
  closeOverlay(input: { overlayId: string }): Promise<void>
  updateSidebarZone(input: { enabled: boolean; width?: number }): Promise<void>
  onTabChange(handler: (event: BrowserTabChange) => void): () => void
  onWindowTabCreated(handler: (event: BrowserTabCreated) => void): () => void
  onTabFocus(handler: (event: BrowserTabFocus) => void): () => void
  onFoundInPage(handler: (event: BrowserFoundInPage) => void): () => void
  onSidebarZoneLeft(handler: () => void): () => void
}

type WebframeGlobal = {
  identity: () => Promise<{ kind: string; windowId?: string }>
  trpc: {
    windows: {
      setSlots: { mutate: (input: unknown) => Promise<unknown> }
    }
    tabs: {
      list?: { query: (input?: unknown) => Promise<Array<{ id: string; url?: string; favicon?: string; presentation?: 'embedded' | 'popup' }>> }
      create: { mutate: (input: unknown) => Promise<{ id: string; favicon?: string }> }
      move: { mutate: (input: unknown) => Promise<unknown> }
      setActive: { mutate: (input: unknown) => Promise<unknown> }
      close: { mutate: (input: unknown) => Promise<unknown> }
      onChange: {
        subscribe: (
          input: unknown,
          opts: { onData?: (data: { tabId: string; patch: Record<string, unknown> }) => void },
        ) => { unsubscribe: () => void }
      }
      onCreated?: {
        subscribe: (
          input: unknown,
          opts: {
            onData?: (data: {
              tab: { id: string; url: string; title: string; favicon?: string; presentation?: 'embedded' | 'popup' }
              windowId: string | null
              openerTabId: string | null
            }) => void
          },
        ) => { unsubscribe: () => void }
      }
    }
    navigation: {
      goto: { mutate: (input: unknown) => Promise<unknown> }
      back: { mutate: (input: unknown) => Promise<unknown> }
      forward: { mutate: (input: unknown) => Promise<unknown> }
      reload: { mutate: (input: unknown) => Promise<unknown> }
    }
    overlays?: {
      createDetached?: { mutate: (input: unknown) => Promise<{ id: string }> }
      attach?: { mutate: (input: unknown) => Promise<unknown> }
      detach?: { mutate: (input: unknown) => Promise<unknown> }
      close?: { mutate: (input: unknown) => Promise<unknown> }
    }
  }
}

type BrowserWindowLike = Window & { webframe?: WebframeGlobal }
type DesktopWindowLike = Window & {
  cloudCodeDesktop?: {
      openBrowserDevTools?: (input: { browserTabId: string }) => Promise<unknown>
      triggerOnePassword?: (input?: { browserTabId?: string }) => Promise<unknown>
      findInBrowserPage?: (input: { browserTabId: string; text: string; forward?: boolean; findNext?: boolean }) => Promise<unknown>
      stopBrowserFindInPage?: (input: { browserTabId: string; action?: 'clearSelection' | 'keepSelection' | 'activateSelection' }) => Promise<unknown>
      setBrowserZoom?: (input: { browserTabId: string; level: number }) => Promise<{ zoomLevel: number }>
      onBrowserFoundInPage?: (handler: (input: BrowserFoundInPage) => void) => () => void
      getAgentBrowserConnections?: () => Promise<{ browserTabIds: string[] }>
      disconnectAgentBrowser?: (input: { browserTabId: string }) => Promise<unknown>
      registerBrowserTabFocusOwner?: (input: { browserTabId: string }) => void
      logBrowserDiagnostics?: (input: { action: string; paneId?: string; browserTabId?: string; slot?: string; url?: string }) => Promise<unknown>
      onBrowserTabFocus?: (handler: (input: BrowserTabFocus) => void) => () => void
      updateSidebarZone?: (input: { enabled: boolean; width?: number }) => Promise<unknown>
      onSidebarZoneLeft?: (handler: () => void) => () => void
      focusOverlay?: (input: { overlayId: string }) => Promise<unknown>
      registerOverlayOwner?: (input: { overlayId: string }) => Promise<unknown>
      unregisterOverlayOwner?: (input: { overlayId: string }) => Promise<unknown>
    }
}

type SlotRecord = { name: string; rect: { x: number; y: number; w: number; h: number } }

export function createBrowserApi(win: BrowserWindowLike | undefined = getWindow()): BrowserApi {
  const slots = new Map<string, SlotRecord>()
  let slotUpdateSeq = 0

  async function getWindowId(): Promise<string> {
    const webframe = getWebframe(win)
    const identity = await webframe.identity()
    if (identity.kind !== 'chrome' || !identity.windowId) {
      throw new Error('browser API is only available in a webframe chrome window')
    }
    return identity.windowId
  }

  async function setSlots(): Promise<void> {
    const webframe = getWebframe(win)
    await webframe.trpc.windows.setSlots.mutate({
      windowId: await getWindowId(),
      slots: Array.from(slots.values()),
    })
  }

  return {
    isAvailable() {
      return !!win?.webframe?.trpc
    },

    getWindowId,

    async listTabs() {
      const webframe = getWebframe(win)
      if (!webframe.trpc.tabs.list) return []
      const records = await webframe.trpc.tabs.list.query()
      return records.map((record) => ({ browserTabId: record.id, url: record.url, favicon: record.favicon, presentation: record.presentation }))
    },

    async createTab(input) {
      const webframe = getWebframe(win)
      const windowId = await getWindowId()
      console.info('[browser-pane] createTab requested', { paneId: input.paneId, windowId, url: input.url, slot: paneSlotName(input.paneId) })
      const record = await trackBrowserCommand('tabs.create', { paneId: input.paneId, url: input.url }, () => webframe.trpc.tabs.create.mutate({
        url: input.url ?? 'about:blank',
        windowId,
        placement: { slot: paneSlotName(input.paneId) },
        active: true,
        ownerKey: paneSlotName(input.paneId),
      }))
      console.info('[browser-pane] createTab resolved', { paneId: input.paneId, windowId, browserTabId: record.id, slot: paneSlotName(input.paneId) })
      void logBrowserDiagnostics(win, { action: 'createTab resolved', paneId: input.paneId, browserTabId: record.id, slot: paneSlotName(input.paneId), url: input.url })
      return { browserTabId: record.id, favicon: record.favicon }
    },

    async attachTab(input) {
      const webframe = getWebframe(win)
      const windowId = await getWindowId()
      console.info('[browser-pane] attachTab requested', { paneId: input.paneId, windowId, browserTabId: input.browserTabId, slot: paneSlotName(input.paneId) })
      const moved = await trackBrowserCommand('tabs.move', { browserTabId: input.browserTabId, paneId: input.paneId }, () => webframe.trpc.tabs.move.mutate({
        tabId: input.browserTabId,
        windowId,
        placement: { slot: paneSlotName(input.paneId) },
      }))
      assertTabFound(moved, input.browserTabId)
      const activated = await trackBrowserCommand('tabs.setActive', { browserTabId: input.browserTabId }, () => webframe.trpc.tabs.setActive.mutate({ tabId: input.browserTabId, windowId }))
      assertTabFound(activated, input.browserTabId)
      console.info('[browser-pane] attachTab resolved', { paneId: input.paneId, windowId, browserTabId: input.browserTabId, slot: paneSlotName(input.paneId) })
      void logBrowserDiagnostics(win, { action: 'attachTab resolved', paneId: input.paneId, browserTabId: input.browserTabId, slot: paneSlotName(input.paneId) })
    },

    async focusTab(input) {
      const webframe = getWebframe(win)
      const windowId = await getWindowId()
      const result = await trackBrowserCommand('tabs.setActive', { browserTabId: input.browserTabId }, () => webframe.trpc.tabs.setActive.mutate({
        tabId: input.browserTabId,
        windowId,
      }))
      assertTabFound(result, input.browserTabId)
    },

    async navigate(input) {
      const webframe = getWebframe(win)
      await trackBrowserCommand('navigation.goto', input, () => webframe.trpc.navigation.goto.mutate({ tabId: input.browserTabId, url: input.url }))
    },

    async back(input) {
      const webframe = getWebframe(win)
      await trackBrowserCommand('navigation.back', input, () => webframe.trpc.navigation.back.mutate({ tabId: input.browserTabId }))
    },

    async forward(input) {
      const webframe = getWebframe(win)
      await trackBrowserCommand('navigation.forward', input, () => webframe.trpc.navigation.forward.mutate({ tabId: input.browserTabId }))
    },

    async reload(input) {
      const webframe = getWebframe(win)
      await trackBrowserCommand('navigation.reload', input, () => webframe.trpc.navigation.reload.mutate({
        tabId: input.browserTabId,
        ignoreCache: input.ignoreCache ?? false,
      }))
    },

    async openDevTools(input) {
      const desktop = win as DesktopWindowLike | undefined
      if (!desktop?.cloudCodeDesktop?.openBrowserDevTools) throw new Error('browser devtools unavailable')
      await desktop.cloudCodeDesktop.openBrowserDevTools({ browserTabId: input.browserTabId })
    },

    async openOnePassword(input) {
      const desktop = win as DesktopWindowLike | undefined
      if (!desktop?.cloudCodeDesktop?.triggerOnePassword) throw new Error('1Password unavailable')
      await desktop.cloudCodeDesktop.triggerOnePassword({ browserTabId: input.browserTabId })
    },

    async findInPage(input) {
      const desktop = win as DesktopWindowLike | undefined
      if (!desktop?.cloudCodeDesktop?.findInBrowserPage) throw new Error('browser find unavailable')
      await desktop.cloudCodeDesktop.findInBrowserPage(input)
    },

    async stopFindInPage(input) {
      const desktop = win as DesktopWindowLike | undefined
      if (!desktop?.cloudCodeDesktop?.stopBrowserFindInPage) throw new Error('browser find unavailable')
      await desktop.cloudCodeDesktop.stopBrowserFindInPage(input)
    },

    async setZoom(input) {
      const desktop = win as DesktopWindowLike | undefined
      if (!desktop?.cloudCodeDesktop?.setBrowserZoom) throw new Error('browser zoom unavailable')
      return desktop.cloudCodeDesktop.setBrowserZoom(input)
    },

    registerTabFocusOwner(input) {
      const desktop = win as DesktopWindowLike | undefined
      desktop?.cloudCodeDesktop?.registerBrowserTabFocusOwner?.(input)
    },

    async getAgentConnections() {
      const desktop = win as DesktopWindowLike | undefined
      if (!desktop?.cloudCodeDesktop?.getAgentBrowserConnections) return { browserTabIds: [] }
      return desktop.cloudCodeDesktop.getAgentBrowserConnections()
    },

    async disconnectAgent(input) {
      const desktop = win as DesktopWindowLike | undefined
      if (!desktop?.cloudCodeDesktop?.disconnectAgentBrowser) return
      await desktop.cloudCodeDesktop.disconnectAgentBrowser(input)
    },

    async closeTab(input) {
      const webframe = getWebframe(win)
      await trackBrowserCommand('tabs.close', input, () => webframe.trpc.tabs.close.mutate({ tabId: input.browserTabId }))
    },

    async setSlot(input) {
      const seq = ++slotUpdateSeq
      slots.set(input.paneId, {
        name: paneSlotName(input.paneId),
        rect: {
          x: input.rect.x,
          y: input.rect.y,
          w: input.rect.width,
          h: input.rect.height,
        },
      })
      console.info('[browser-pane] setSlot requested', { seq, paneId: input.paneId, slot: paneSlotName(input.paneId), rect: input.rect, slotCount: slots.size })
      await trackBrowserCommand('windows.setSlots', { paneId: input.paneId, rect: input.rect }, setSlots)
      console.info('[browser-pane] setSlot resolved', { seq, paneId: input.paneId, slot: paneSlotName(input.paneId), rect: input.rect, slotCount: slots.size })
      void logBrowserDiagnostics(win, { action: 'setSlot resolved', paneId: input.paneId, slot: paneSlotName(input.paneId) })
    },

    async createDetachedOverlay(input) {
      const webframe = getWebframe(win)
      if (!webframe.trpc.overlays?.createDetached) throw new Error('webframe detached overlays unavailable')
      const overlay = await trackBrowserCommand('overlays.createDetached', { url: input.url }, () => webframe.trpc.overlays!.createDetached!.mutate({
        url: input.url,
        transparent: input.transparent ?? true,
        clickThrough: input.clickThrough ?? false,
      }))
      const desktop = win as DesktopWindowLike | undefined
      await desktop?.cloudCodeDesktop?.registerOverlayOwner?.({ overlayId: overlay.id })
      return { overlayId: overlay.id }
    },

    async attachOverlay(input) {
      const webframe = getWebframe(win)
      if (!webframe.trpc.overlays?.attach) throw new Error('webframe overlay attach unavailable')
      const windowId = await getWindowId()
      await trackBrowserCommand('overlays.attach', { overlayId: input.overlayId, placement: input.placement }, () => webframe.trpc.overlays!.attach!.mutate({
        overlayId: input.overlayId,
        windowId,
        placement: input.placement,
      }))
    },

    async focusOverlay(input) {
      const desktop = win as DesktopWindowLike | undefined
      await trackBrowserCommand('desktop.focusOverlay', input, () => desktop?.cloudCodeDesktop?.focusOverlay?.(input) ?? Promise.resolve())
    },

    async detachOverlay(input) {
      const webframe = getWebframe(win)
      if (!webframe.trpc.overlays?.detach) throw new Error('webframe overlay detach unavailable')
      await trackBrowserCommand('overlays.detach', input, () => webframe.trpc.overlays!.detach!.mutate({ overlayId: input.overlayId }))
    },

    async closeOverlay(input) {
      const webframe = getWebframe(win)
      if (!webframe.trpc.overlays?.close) throw new Error('webframe overlay close unavailable')
      const desktop = win as DesktopWindowLike | undefined
      await desktop?.cloudCodeDesktop?.unregisterOverlayOwner?.({ overlayId: input.overlayId })
      await trackBrowserCommand('overlays.close', input, () => webframe.trpc.overlays!.close!.mutate({ overlayId: input.overlayId }))
    },

    async updateSidebarZone(input) {
      const desktop = win as DesktopWindowLike | undefined
      await desktop?.cloudCodeDesktop?.updateSidebarZone?.(input)
    },

    onTabChange(handler) {
      if (!win?.webframe?.trpc) return () => undefined
      const sub = win.webframe.trpc.tabs.onChange.subscribe(undefined, {
        onData(data) {
          handler({ browserTabId: data.tabId, patch: data.patch })
        },
      })
      return () => sub.unsubscribe()
    },

    onWindowTabCreated(handler) {
      if (!win?.webframe?.trpc?.tabs.onCreated) return () => undefined
      let unsubscribed = false
      let sub: { unsubscribe: () => void } | null = null
      void getWindowId().then((windowId) => {
        if (unsubscribed || !win?.webframe?.trpc?.tabs.onCreated) return
        sub = win.webframe.trpc.tabs.onCreated.subscribe({ windowId }, {
          onData(data) {
            handler({
              browserTabId: data.tab.id,
              windowId: data.windowId,
              openerBrowserTabId: data.openerTabId,
              url: data.tab.url,
              title: data.tab.title,
              favicon: data.tab.favicon,
              presentation: data.tab.presentation,
            })
          },
        })
      })
      return () => {
        unsubscribed = true
        sub?.unsubscribe()
      }
    },

    onTabFocus(handler) {
      const desktop = win as DesktopWindowLike | undefined
      return desktop?.cloudCodeDesktop?.onBrowserTabFocus?.(handler) ?? (() => undefined)
    },

    onFoundInPage(handler) {
      const desktop = win as DesktopWindowLike | undefined
      return desktop?.cloudCodeDesktop?.onBrowserFoundInPage?.(handler) ?? (() => undefined)
    },

    onSidebarZoneLeft(handler) {
      const desktop = win as DesktopWindowLike | undefined
      return desktop?.cloudCodeDesktop?.onSidebarZoneLeft?.(handler) ?? (() => undefined)
    },
  }
}

export const browserApi = createBrowserApi()

export function paneSlotName(paneId: string): string {
  return `browser-pane:${paneId}`
}

function getWindow(): BrowserWindowLike | undefined {
  return typeof window === 'undefined' ? undefined : (window as BrowserWindowLike)
}

function getWebframe(win: BrowserWindowLike | undefined): WebframeGlobal {
  if (!win?.webframe?.trpc) throw new Error('browser API is unavailable outside Electron')
  return win.webframe
}

function assertTabFound(result: unknown, browserTabId: string): void {
  if (!isTabNotFoundResult(result)) return
  console.info(`Native browser tab ${browserTabId} no longer exists; creating a replacement tab`)
  throw new Error(`TAB_NOT_FOUND: ${browserTabId}`)
}

function isTabNotFoundResult(result: unknown): result is { ok: false; code: 'TAB_NOT_FOUND' } {
  return typeof result === 'object' && result !== null && 'ok' in result && 'code' in result
    && result.ok === false
    && result.code === 'TAB_NOT_FOUND'
}

async function logBrowserDiagnostics(win: BrowserWindowLike | undefined, input: { action: string; paneId?: string; browserTabId?: string; slot?: string; url?: string }): Promise<void> {
  const desktop = win as DesktopWindowLike | undefined
  if (!desktop?.cloudCodeDesktop?.logBrowserDiagnostics) return
  try {
    const diagnostics = await desktop.cloudCodeDesktop.logBrowserDiagnostics(input)
    console.info('[browser-pane] native diagnostics', diagnostics)
  } catch (error) {
    console.info('[browser-pane] native diagnostics failed', { action: input.action, paneId: input.paneId, browserTabId: input.browserTabId, message: error instanceof Error ? error.message : String(error) })
  }
}

async function trackBrowserCommand<T>(name: string, ctx: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const startedAt = nowMs()
  let settled = false
  const timeout = globalThis.setTimeout(() => {
    if (settled) return
    logBrowserCommand('pending', name, startedAt, ctx)
  }, 5_000)
  try {
    const result = await run()
    settled = true
    globalThis.clearTimeout(timeout)
    const elapsedMs = nowMs() - startedAt
    if (elapsedMs > 750) logBrowserCommand('slow', name, startedAt, ctx, elapsedMs)
    return result
  } catch (error) {
    settled = true
    globalThis.clearTimeout(timeout)
    logBrowserCommand('failed', name, startedAt, {
      ...ctx,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function logBrowserCommand(state: 'pending' | 'slow' | 'failed', name: string, startedAt: number, ctx: Record<string, unknown>, elapsedMs = nowMs() - startedAt): void {
  const payload = { command: name, elapsedMs: Math.round(elapsedMs), ...ctx, url: getCurrentUrl() }
  console.warn(`[browser-api] command ${state} ${JSON.stringify(payload)}`)
  clientLogger.warn(`[browser-api] command ${state}`, payload)
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function getCurrentUrl(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.href
}
