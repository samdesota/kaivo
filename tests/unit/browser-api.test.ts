import { describe, expect, it, vi } from 'vitest'
import { createBrowserApi, paneSlotName } from '../../src/lib/browser-api.js'

function makeWindow() {
  const calls: Record<string, ReturnType<typeof vi.fn>> = {
    setSlots: vi.fn(async () => ({ ok: true })),
    create: vi.fn(async () => ({ id: 'tab-1' })),
    move: vi.fn(async () => ({ ok: true })),
    setActive: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => ({ ok: true })),
    goto: vi.fn(async () => ({ ok: true })),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  }
  const win = {
    webframe: {
      identity: vi.fn(async () => ({ kind: 'chrome', windowId: 'window-1' })),
      trpc: {
        windows: { setSlots: { mutate: calls.setSlots } },
        tabs: {
          create: { mutate: calls.create },
          move: { mutate: calls.move },
          setActive: { mutate: calls.setActive },
          close: { mutate: calls.close },
          onChange: { subscribe: calls.subscribe },
        },
        navigation: { goto: { mutate: calls.goto } },
      },
    },
  } as unknown as Window & { webframe: unknown }
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
    await api.closeTab({ browserTabId: 'tab-1' })
    expect(calls.goto).toHaveBeenLastCalledWith({ tabId: 'tab-1', url: 'https://example.org' })
    expect(calls.close).toHaveBeenLastCalledWith({ tabId: 'tab-1' })
  })
})
