import { describe, expect, it, vi } from 'vitest'
import { createBrowserApi, paneSlotName } from '../../src/lib/browser-api.js'

function makeWindow() {
  const calls: Record<string, ReturnType<typeof vi.fn>> = {
    setSlots: vi.fn(async () => ({ ok: true })),
    create: vi.fn(async () => ({ id: 'tab-1', favicon: 'https://example.com/favicon.ico' })),
    list: vi.fn(async () => [{ id: 'tab-1', url: 'https://example.com', title: 'Example title', favicon: 'https://example.com/favicon.ico', presentation: 'embedded' }]),
    get: vi.fn(async () => ({ id: 'tab-1', url: 'https://example.com', title: 'Example title', favicon: 'https://example.com/favicon.ico', presentation: 'embedded' })),
    move: vi.fn(async () => ({ ok: true })),
    setActive: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => ({ ok: true })),
    goto: vi.fn(async () => ({ ok: true })),
    back: vi.fn(async () => ({ ok: true })),
    forward: vi.fn(async () => ({ ok: true })),
    reload: vi.fn(async () => ({ ok: true })),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  }
  const win = {
    webframe: {
      identity: vi.fn(async () => ({ kind: 'chrome', windowId: 'window-1' })),
      trpc: {
        windows: { setSlots: { mutate: calls.setSlots } },
        tabs: {
          create: { mutate: calls.create },
          list: { query: calls.list },
          get: { query: calls.get },
          move: { mutate: calls.move },
          setActive: { mutate: calls.setActive },
          close: { mutate: calls.close },
          onChange: { subscribe: calls.subscribe },
        },
        navigation: {
          goto: { mutate: calls.goto },
          back: { mutate: calls.back },
          forward: { mutate: calls.forward },
          reload: { mutate: calls.reload },
        },
      },
    },
  } as unknown as Parameters<typeof createBrowserApi>[0]
  return { win, calls }
}

describe('browser API adapter', () => {
  it('reports unavailable outside Electron', () => {
    expect(createBrowserApi(undefined).isAvailable()).toBe(false)
  })

  it('maps pane ids, slots, tab control, and navigation to webframe trpc operations', async () => {
    const { win, calls } = makeWindow()
    const api = createBrowserApi(win)

    expect(api.isAvailable()).toBe(true)
    await expect(api.listTabs()).resolves.toEqual([{
      browserTabId: 'tab-1',
      url: 'https://example.com',
      title: 'Example title',
      favicon: 'https://example.com/favicon.ico',
      presentation: 'embedded',
    }])
    await expect(api.getTab({ browserTabId: 'tab-1' })).resolves.toEqual({
      browserTabId: 'tab-1',
      url: 'https://example.com',
      title: 'Example title',
      favicon: 'https://example.com/favicon.ico',
      presentation: 'embedded',
    })
    expect(calls.get).toHaveBeenLastCalledWith({ tabId: 'tab-1' })
    await api.setSlot({ paneId: 'pane-1', rect: { x: 1, y: 2, width: 300, height: 200 } })
    expect(calls.setSlots).toHaveBeenLastCalledWith({
      windowId: 'window-1',
      slots: [{ name: paneSlotName('pane-1'), rect: { x: 1, y: 2, w: 300, h: 200 } }],
    })

    await expect(api.createTab({ paneId: 'pane-1', url: 'https://example.com' })).resolves.toEqual({
      browserTabId: 'tab-1',
      favicon: 'https://example.com/favicon.ico',
    })
    expect(calls.create).toHaveBeenLastCalledWith({
      url: 'https://example.com',
      windowId: 'window-1',
      placement: { slot: paneSlotName('pane-1') },
      active: true,
      ownerKey: paneSlotName('pane-1'),
    })

    await api.attachTab({ paneId: 'pane-1', browserTabId: 'tab-1' })
    expect(calls.move).toHaveBeenLastCalledWith({
      tabId: 'tab-1',
      windowId: 'window-1',
      placement: { slot: paneSlotName('pane-1') },
    })
    expect(calls.setActive).toHaveBeenLastCalledWith({ tabId: 'tab-1', windowId: 'window-1' })

    await api.focusTab({ browserTabId: 'tab-1' })
    await api.navigate({ browserTabId: 'tab-1', url: 'https://example.org' })
    await api.back({ browserTabId: 'tab-1' })
    await api.forward({ browserTabId: 'tab-1' })
    await api.reload({ browserTabId: 'tab-1' })
    await api.closeTab({ browserTabId: 'tab-1' })
    expect(calls.goto).toHaveBeenLastCalledWith({ tabId: 'tab-1', url: 'https://example.org' })
    expect(calls.back).toHaveBeenLastCalledWith({ tabId: 'tab-1' })
    expect(calls.forward).toHaveBeenLastCalledWith({ tabId: 'tab-1' })
    expect(calls.reload).toHaveBeenLastCalledWith({ tabId: 'tab-1', ignoreCache: false })
    expect(calls.close).toHaveBeenLastCalledWith({ tabId: 'tab-1' })
  })

  it('opens native browser tab devtools through the desktop preload bridge', async () => {
    const { win } = makeWindow()
    const openBrowserDevTools = vi.fn(async () => ({ ok: true }))
    const api = createBrowserApi({ ...win, cloudCodeDesktop: { openBrowserDevTools } } as Parameters<typeof createBrowserApi>[0])

    await api.openDevTools({ browserTabId: 'tab-1' })

    expect(openBrowserDevTools).toHaveBeenCalledWith({ browserTabId: 'tab-1' })
  })

  it('opens the 1Password browser action through the desktop preload bridge', async () => {
    const { win } = makeWindow()
    const triggerOnePassword = vi.fn(async () => ({ ok: true }))
    const api = createBrowserApi({ ...win, cloudCodeDesktop: { triggerOnePassword } } as Parameters<typeof createBrowserApi>[0])

    await api.openOnePassword({ browserTabId: 'tab-1' })

    expect(triggerOnePassword).toHaveBeenCalledWith({ browserTabId: 'tab-1' })
  })

  it('turns webframe tab-not-found results into recoverable client errors', async () => {
    const { win, calls } = makeWindow()
    calls.move!.mockResolvedValueOnce({ ok: false, code: 'TAB_NOT_FOUND', message: 'Tab tab-1 not found' })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    try {
      await expect(createBrowserApi(win).attachTab({ paneId: 'pane-1', browserTabId: 'tab-1' })).rejects.toThrow(
        'TAB_NOT_FOUND: tab-1',
      )
      expect(info).toHaveBeenCalledWith('Native browser tab tab-1 no longer exists; creating a replacement tab')
    } finally {
      info.mockRestore()
    }
  })

  it('maps favicon data from webframe change and created subscriptions', async () => {
    const { win, calls } = makeWindow()
    const createdSubscribe = vi.fn(() => ({ unsubscribe: vi.fn() }))
    ;(win as any).webframe.trpc.tabs.onCreated = { subscribe: createdSubscribe }
    const api = createBrowserApi(win)
    const onChange = vi.fn()
    const onCreated = vi.fn()

    api.onTabChange(onChange)
    const changeCall = calls.subscribe!.mock.calls[0] as [unknown, { onData: (data: { tabId: string; patch: Record<string, unknown> }) => void }]
    const changeOpts = changeCall[1]
    changeOpts.onData({ tabId: 'tab-1', patch: { favicon: 'https://example.com/favicon.ico' } })
    expect(onChange).toHaveBeenCalledWith({
      browserTabId: 'tab-1',
      patch: { favicon: 'https://example.com/favicon.ico' },
    })

    api.onWindowTabCreated(onCreated)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const createdCall = createdSubscribe.mock.calls[0] as unknown as [unknown, { onData: (data: {
      tab: { id: string; url: string; title: string; favicon?: string; presentation?: 'embedded' | 'popup' }
      windowId: string | null
      openerTabId: string | null
    }) => void }]
    const createdOpts = createdCall[1]
    createdOpts.onData({
      tab: {
        id: 'tab-2',
        url: 'https://example.com/new',
        title: 'Example',
        favicon: 'https://example.com/favicon.ico',
        presentation: 'embedded',
      },
      windowId: 'window-1',
      openerTabId: 'tab-1',
    })
    expect(onCreated).toHaveBeenCalledWith({
      browserTabId: 'tab-2',
      windowId: 'window-1',
      openerBrowserTabId: 'tab-1',
      url: 'https://example.com/new',
      title: 'Example',
      favicon: 'https://example.com/favicon.ico',
      presentation: 'embedded',
    })
  })

  it('maps desktop native focus events to browser tab focus events', () => {
    const { win } = makeWindow()
    let listener: ((event: { browserTabId: string }) => void) | undefined
    const api = createBrowserApi({
      ...win,
      cloudCodeDesktop: {
        onBrowserTabFocus: vi.fn((callback) => {
          listener = callback
          return vi.fn()
        }),
      },
    } as Parameters<typeof createBrowserApi>[0])
    const onFocus = vi.fn()

    api.onTabFocus(onFocus)
    listener?.({ browserTabId: 'tab-1' })

    expect(onFocus).toHaveBeenCalledWith({ browserTabId: 'tab-1' })
  })
})
