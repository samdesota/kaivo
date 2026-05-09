import { describe, expect, it, vi } from 'vitest'
import { createBrowserApi, paneSlotName } from '../../src/lib/browser-api.js'

function makeWindow() {
  const calls: Record<string, ReturnType<typeof vi.fn>> = {
    setSlots: vi.fn(async () => ({ ok: true })),
    create: vi.fn(async () => ({ id: 'tab-1' })),
    list: vi.fn(async () => [{ id: 'tab-1', url: 'https://example.com' }]),
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
    await expect(api.listTabs()).resolves.toEqual([{ browserTabId: 'tab-1', url: 'https://example.com' }])
    await api.setSlot({ paneId: 'pane-1', rect: { x: 1, y: 2, width: 300, height: 200 } })
    expect(calls.setSlots).toHaveBeenLastCalledWith({
      windowId: 'window-1',
      slots: [{ name: paneSlotName('pane-1'), rect: { x: 1, y: 2, w: 300, h: 200 } }],
    })

    await expect(api.createTab({ paneId: 'pane-1', url: 'https://example.com' })).resolves.toEqual({
      browserTabId: 'tab-1',
    })
    expect(calls.create).toHaveBeenLastCalledWith({
      url: 'https://example.com',
      windowId: 'window-1',
      placement: { slot: paneSlotName('pane-1') },
      active: true,
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
})
