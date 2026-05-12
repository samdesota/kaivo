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
  getAgentConnections(): Promise<{ browserTabIds: string[] }>
  disconnectAgent(input: { browserTabId: string }): Promise<void>
  closeTab(input: { browserTabId: string }): Promise<void>
  setSlot(input: BrowserSlotUpdate): Promise<void>
  createDetachedOverlay(input: { url: string; transparent?: boolean; clickThrough?: boolean }): Promise<{ overlayId: string }>
  attachOverlay(input: { overlayId: string; placement: { x: number; y: number; w: number; h: number } }): Promise<void>
  focusOverlay(input: { overlayId: string }): Promise<void>
  detachOverlay(input: { overlayId: string }): Promise<void>
  closeOverlay(input: { overlayId: string }): Promise<void>
  onTabChange(handler: (event: BrowserTabChange) => void): () => void
  onWindowTabCreated(handler: (event: BrowserTabCreated) => void): () => void
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
      getAgentBrowserConnections?: () => Promise<{ browserTabIds: string[] }>
      disconnectAgentBrowser?: (input: { browserTabId: string }) => Promise<unknown>
      focusOverlay?: (input: { overlayId: string }) => Promise<unknown>
    }
}

type SlotRecord = { name: string; rect: { x: number; y: number; w: number; h: number } }

export function createBrowserApi(win: BrowserWindowLike | undefined = getWindow()): BrowserApi {
  const slots = new Map<string, SlotRecord>()

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
      const record = await webframe.trpc.tabs.create.mutate({
        url: input.url ?? 'about:blank',
        windowId: await getWindowId(),
        placement: { slot: paneSlotName(input.paneId) },
        active: true,
      })
      return { browserTabId: record.id, favicon: record.favicon }
    },

    async attachTab(input) {
      const webframe = getWebframe(win)
      const windowId = await getWindowId()
      const moved = await webframe.trpc.tabs.move.mutate({
        tabId: input.browserTabId,
        windowId,
        placement: { slot: paneSlotName(input.paneId) },
      })
      assertTabFound(moved, input.browserTabId)
      const activated = await webframe.trpc.tabs.setActive.mutate({ tabId: input.browserTabId, windowId })
      assertTabFound(activated, input.browserTabId)
    },

    async focusTab(input) {
      const webframe = getWebframe(win)
      const result = await webframe.trpc.tabs.setActive.mutate({
        tabId: input.browserTabId,
        windowId: await getWindowId(),
      })
      assertTabFound(result, input.browserTabId)
    },

    async navigate(input) {
      const webframe = getWebframe(win)
      await webframe.trpc.navigation.goto.mutate({ tabId: input.browserTabId, url: input.url })
    },

    async back(input) {
      const webframe = getWebframe(win)
      await webframe.trpc.navigation.back.mutate({ tabId: input.browserTabId })
    },

    async forward(input) {
      const webframe = getWebframe(win)
      await webframe.trpc.navigation.forward.mutate({ tabId: input.browserTabId })
    },

    async reload(input) {
      const webframe = getWebframe(win)
      await webframe.trpc.navigation.reload.mutate({
        tabId: input.browserTabId,
        ignoreCache: input.ignoreCache ?? false,
      })
    },

    async openDevTools(input) {
      const desktop = win as DesktopWindowLike | undefined
      if (!desktop?.cloudCodeDesktop?.openBrowserDevTools) throw new Error('browser devtools unavailable')
      await desktop.cloudCodeDesktop.openBrowserDevTools({ browserTabId: input.browserTabId })
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
      await webframe.trpc.tabs.close.mutate({ tabId: input.browserTabId })
    },

    async setSlot(input) {
      slots.set(input.paneId, {
        name: paneSlotName(input.paneId),
        rect: {
          x: input.rect.x,
          y: input.rect.y,
          w: input.rect.width,
          h: input.rect.height,
        },
      })
      await setSlots()
    },

    async createDetachedOverlay(input) {
      const webframe = getWebframe(win)
      if (!webframe.trpc.overlays?.createDetached) throw new Error('webframe detached overlays unavailable')
      const overlay = await webframe.trpc.overlays.createDetached.mutate({
        url: input.url,
        transparent: input.transparent ?? true,
        clickThrough: input.clickThrough ?? false,
      })
      return { overlayId: overlay.id }
    },

    async attachOverlay(input) {
      const webframe = getWebframe(win)
      if (!webframe.trpc.overlays?.attach) throw new Error('webframe overlay attach unavailable')
      await webframe.trpc.overlays.attach.mutate({
        overlayId: input.overlayId,
        windowId: await getWindowId(),
        placement: input.placement,
      })
    },

    async focusOverlay(input) {
      const desktop = win as DesktopWindowLike | undefined
      await desktop?.cloudCodeDesktop?.focusOverlay?.(input)
    },

    async detachOverlay(input) {
      const webframe = getWebframe(win)
      if (!webframe.trpc.overlays?.detach) throw new Error('webframe overlay detach unavailable')
      await webframe.trpc.overlays.detach.mutate({ overlayId: input.overlayId })
    },

    async closeOverlay(input) {
      const webframe = getWebframe(win)
      if (!webframe.trpc.overlays?.close) throw new Error('webframe overlay close unavailable')
      await webframe.trpc.overlays.close.mutate({ overlayId: input.overlayId })
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
