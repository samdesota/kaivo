export type BrowserSlotUpdate = {
  paneId: string
  rect: { x: number; y: number; width: number; height: number }
}

export type BrowserTabChange = {
  browserTabId: string
  patch: Record<string, unknown>
}

export type BrowserApi = {
  isAvailable(): boolean
  createTab(input: { paneId: string; url?: string }): Promise<{ browserTabId: string }>
  attachTab(input: { paneId: string; browserTabId: string }): Promise<void>
  focusTab(input: { browserTabId: string }): Promise<void>
  navigate(input: { browserTabId: string; url: string }): Promise<void>
  closeTab(input: { browserTabId: string }): Promise<void>
  setSlot(input: BrowserSlotUpdate): Promise<void>
  onTabChange(handler: (event: BrowserTabChange) => void): () => void
}

type WebframeGlobal = {
  identity: () => Promise<{ kind: string; windowId?: string }>
  trpc: {
    windows: {
      setSlots: { mutate: (input: unknown) => Promise<unknown> }
    }
    tabs: {
      create: { mutate: (input: unknown) => Promise<{ id: string }> }
      move: { mutate: (input: unknown) => Promise<unknown> }
      setActive: { mutate: (input: unknown) => Promise<unknown> }
      close: { mutate: (input: unknown) => Promise<unknown> }
      onChange: {
        subscribe: (
          input: unknown,
          opts: { onData?: (data: { tabId: string; patch: Record<string, unknown> }) => void },
        ) => { unsubscribe: () => void }
      }
    }
    navigation: {
      goto: { mutate: (input: unknown) => Promise<unknown> }
    }
  }
}

type BrowserWindowLike = Window & { webframe?: WebframeGlobal }

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

    async createTab(input) {
      const webframe = getWebframe(win)
      const record = await webframe.trpc.tabs.create.mutate({
        url: input.url ?? 'about:blank',
        windowId: await getWindowId(),
        placement: { slot: paneSlotName(input.paneId) },
        active: true,
      })
      return { browserTabId: record.id }
    },

    async attachTab(input) {
      const webframe = getWebframe(win)
      const windowId = await getWindowId()
      await webframe.trpc.tabs.move.mutate({
        tabId: input.browserTabId,
        windowId,
        placement: { slot: paneSlotName(input.paneId) },
      })
      await webframe.trpc.tabs.setActive.mutate({ tabId: input.browserTabId, windowId })
    },

    async focusTab(input) {
      const webframe = getWebframe(win)
      await webframe.trpc.tabs.setActive.mutate({
        tabId: input.browserTabId,
        windowId: await getWindowId(),
      })
    },

    async navigate(input) {
      const webframe = getWebframe(win)
      await webframe.trpc.navigation.goto.mutate({ tabId: input.browserTabId, url: input.url })
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

    onTabChange(handler) {
      if (!win?.webframe?.trpc) return () => undefined
      const sub = win.webframe.trpc.tabs.onChange.subscribe(undefined, {
        onData(data) {
          handler({ browserTabId: data.tabId, patch: data.patch })
        },
      })
      return () => sub.unsubscribe()
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
