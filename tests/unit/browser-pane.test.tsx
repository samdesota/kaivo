// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = {
  isAvailable: vi.fn(() => true),
  createTab: vi.fn(async () => ({ browserTabId: 'native-tab-1' })),
  attachTab: vi.fn(async () => undefined),
  focusTab: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
  back: vi.fn(async () => undefined),
  forward: vi.fn(async () => undefined),
  reload: vi.fn(async () => undefined),
  openDevTools: vi.fn(async () => undefined),
  openOnePassword: vi.fn(async () => undefined),
  findInPage: vi.fn(async () => undefined),
  stopFindInPage: vi.fn(async () => undefined),
  setZoom: vi.fn(async (input: { level: number }) => ({ zoomLevel: input.level })),
  registerTabFocusOwner: vi.fn(() => undefined),
  getAgentConnections: vi.fn(async () => ({ browserTabIds: [] })),
  disconnectAgent: vi.fn(async () => undefined),
  closeTab: vi.fn(async () => undefined),
  setSlot: vi.fn(async () => undefined),
  onTabChange: vi.fn(() => () => undefined),
  onTabFocus: vi.fn(() => () => undefined),
  onFoundInPage: vi.fn(() => () => undefined),
}

vi.mock('../../src/lib/browser-api', () => ({
  browserApi: api,
}))

const openCreateBookmarkOverlay = vi.hoisted(() => vi.fn(async () => 'bookmark-1'))
const openBrowserUrlPopoverOverlay = vi.hoisted(() => vi.fn(async () => ({ update: vi.fn(), close: vi.fn() })))

vi.mock('../../src/lib/overlay-layer-controller', () => ({
  openCreateBookmarkOverlay,
  openBrowserUrlPopoverOverlay,
}))

class TestResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

const { BrowserPane } = await import('../../src/components/browser-pane')
type BookmarkRecord = import('../../src/routes/workspace/bookmarks-store').BookmarkRecord
let rect = { x: 10, y: 20, width: 300, height: 200 }

function bookmark(input: Partial<BookmarkRecord> & { title: string; url: string }): BookmarkRecord {
  return {
    id: input.id ?? input.title,
    title: input.title,
    url: input.url,
    normalizedUrl: input.normalizedUrl ?? input.url,
    origin: input.origin ?? new URL(input.url).origin,
    faviconDataUrl: input.faviconDataUrl ?? null,
    faviconUrl: input.faviconUrl ?? null,
    createdAt: input.createdAt ?? new Date('2026-05-16T00:00:00Z'),
    updatedAt: input.updatedAt ?? new Date('2026-05-16T00:00:00Z'),
  }
}

describe('BrowserPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.onTabChange.mockReturnValue(() => undefined)
    api.onTabFocus.mockReturnValue(() => undefined)
    api.onFoundInPage.mockReturnValue(() => undefined)
    api.setZoom.mockImplementation(async (input: { level: number }) => ({ zoomLevel: input.level }))
    api.isAvailable.mockReturnValue(true)
    api.getAgentConnections.mockResolvedValue({ browserTabIds: [] })
    openCreateBookmarkOverlay.mockClear()
    openBrowserUrlPopoverOverlay.mockClear()
    openBrowserUrlPopoverOverlay.mockResolvedValue({ update: vi.fn(), close: vi.fn() })
    rect = { x: 10, y: 20, width: 300, height: 200 }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: TestResizeObserver,
      configurable: true,
    })
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      value: () => rect,
      configurable: true,
    })
  })

  afterEach(() => cleanup())

  it('calls browser API methods on mount, resize activation, and cleanup', async () => {
    const onBrowserTabId = vi.fn()
    const view = render(
      <BrowserPane
        paneId="pane-1"
        url="https://example.com"
        active={true}
        onBrowserTabId={onBrowserTabId}
      />,
    )

    await waitFor(() => expect(api.createTab).toHaveBeenCalledWith({
      paneId: 'pane-1',
      url: 'https://example.com',
    }))
    expect(api.setSlot).toHaveBeenCalledWith({
      paneId: 'pane-1',
      rect: { x: 10, y: 20, width: 300, height: 200 },
    })
    expect(onBrowserTabId).toHaveBeenCalledWith('native-tab-1')

    rect = { x: 15, y: 25, width: 350, height: 240 }
    window.dispatchEvent(new Event('resize'))
    await waitFor(() => expect(api.setSlot).toHaveBeenCalledWith({
      paneId: 'pane-1',
      rect: { x: 15, y: 25, width: 350, height: 240 },
    }))

    view.rerender(
      <BrowserPane paneId="pane-1" browserTabId="native-tab-1" active={false} />,
    )
    await waitFor(() => expect(api.setSlot).toHaveBeenCalledWith({
      paneId: 'pane-1',
      rect: { x: 0, y: 0, width: 0, height: 0 },
    }))

    view.rerender(
      <BrowserPane paneId="pane-1" browserTabId="native-tab-1" active={true} />,
    )
    await waitFor(() => expect(api.focusTab).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' }))
    expect(api.attachTab).not.toHaveBeenCalled()

    await act(async () => view.unmount())
    expect(api.closeTab).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
  })

  it('renders an unavailable state outside Electron', () => {
    api.isAvailable.mockReturnValue(false)
    const view = render(<BrowserPane paneId="pane-1" active={true} url="localhost:5173" />)
    expect(view.getByText('Browser pane unavailable')).toBeTruthy()
    expect(view.getByText('http://localhost:5173')).toBeTruthy()
    const link = view.getByRole('link', { name: 'Open externally' }) as HTMLAnchorElement
    expect(link.href).toBe('http://localhost:5173/')
    expect(api.createTab).not.toHaveBeenCalled()
  })

  it('keeps browser-unavailable fallback quiet with malformed bookmark context', () => {
    api.isAvailable.mockReturnValue(false)
    const malformed = { id: 'bad', title: null, url: null, normalizedUrl: null, origin: null, updatedAt: null } as unknown as BookmarkRecord
    expect(() => render(<BrowserPane paneId="pane-1" active={true} url="doc" bookmarks={[malformed]} />)).not.toThrow()
    expect(screen.getByText('Browser pane unavailable')).toBeTruthy()
  })

  it('renders controls and drives browser navigation', async () => {
    const view = render(
      <BrowserPane paneId="pane-1" browserTabId="native-tab-1" url="https://example.com" active={true} />,
    )

    await waitFor(() => expect(api.attachTab).toHaveBeenCalledWith({
      paneId: 'pane-1',
      browserTabId: 'native-tab-1',
    }))

    fireEvent.click(view.getByLabelText('Back'))
    fireEvent.click(view.getByLabelText('Forward'))
    fireEvent.click(view.getByLabelText('Reload'))
    fireEvent.click(view.getByLabelText('Open DevTools'))
    fireEvent.click(view.getByLabelText('Open 1Password'))
    expect(api.back).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
    expect(api.forward).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
    expect(api.reload).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
    expect(api.openDevTools).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
    expect(api.openOnePassword).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })

    const input = view.getByLabelText('URL') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'example.org/path' } })
    fireEvent.submit(view.getByLabelText('Browser controls'))
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith({
      browserTabId: 'native-tab-1',
      url: 'https://example.org/path',
    }))
  })

  it('opens find in page from shortcut and drives browser find controls', async () => {
    let onFoundInPage: ((event: { browserTabId: string; activeMatchOrdinal: number; matches: number }) => void) | undefined
    api.onFoundInPage.mockImplementation((handler) => {
      onFoundInPage = handler
      return () => undefined
    })
    const view = render(<BrowserPane paneId="pane-1" browserTabId="native-tab-1" url="https://example.com" active={true} />)

    await waitFor(() => expect(api.attachTab).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    const findInput = view.getByLabelText('Find in page') as HTMLInputElement
    fireEvent.change(findInput, { target: { value: 'needle' } })

    await waitFor(() => expect(api.findInPage).toHaveBeenCalledWith({
      browserTabId: 'native-tab-1',
      text: 'needle',
      forward: true,
      findNext: false,
    }))

    act(() => onFoundInPage?.({ browserTabId: 'native-tab-1', activeMatchOrdinal: 2, matches: 5 }))
    expect(view.getByText('2/5')).toBeTruthy()

    fireEvent.keyDown(findInput, { key: 'Enter' })
    await waitFor(() => expect(api.findInPage).toHaveBeenCalledWith(expect.objectContaining({
      browserTabId: 'native-tab-1',
      text: 'needle',
      forward: true,
      findNext: true,
    })))

    fireEvent.keyDown(findInput, { key: 'Escape' })
    await waitFor(() => expect(api.stopFindInPage).toHaveBeenCalledWith({ browserTabId: 'native-tab-1', action: 'keepSelection' }))
  })

  it('zooms the browser pane from keyboard shortcuts', async () => {
    render(<BrowserPane paneId="pane-1" browserTabId="native-tab-1" url="https://example.com" active={true} />)

    await waitFor(() => expect(api.attachTab).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: '=', metaKey: true })
    await waitFor(() => expect(api.setZoom).toHaveBeenCalledWith({ browserTabId: 'native-tab-1', level: 0.5 }))

    fireEvent.keyDown(window, { key: '0', metaKey: true })
    await waitFor(() => expect(api.setZoom).toHaveBeenCalledWith({ browserTabId: 'native-tab-1', level: 0 }))
  })

  it('filters URL bar bookmarks and renders favicon rows without bookmark labels', async () => {
    const view = render(
      <BrowserPane
        paneId="pane-1"
        browserTabId="native-tab-1"
        url="https://example.com"
        active={true}
        bookmarks={[bookmark({ title: 'Docs', url: 'https://example.com/docs', faviconDataUrl: 'data:image/png;base64,abc' })]}
      />,
    )
    await waitFor(() => expect(api.attachTab).toHaveBeenCalled())
    const input = view.getByLabelText('URL') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'doc' } })

    await waitFor(() => expect(openBrowserUrlPopoverOverlay).toHaveBeenCalled())
    const [request] = openBrowserUrlPopoverOverlay.mock.calls.at(-1)!
    expect(request.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'bookmark',
        title: 'Docs',
        detail: 'example.com',
        iconUrl: 'data:image/png;base64,abc',
      }),
    ]))
    expect(view.queryByText('bookmark')).toBeNull()
  })

  it('renders search fallback row and navigates to encoded search URL', async () => {
    const view = render(<BrowserPane paneId="pane-1" browserTabId="native-tab-1" url="https://example.com" active={true} />)
    await waitFor(() => expect(api.attachTab).toHaveBeenCalled())
    const input = view.getByLabelText('URL') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'foo bar' } })
    await waitFor(() => expect(openBrowserUrlPopoverOverlay).toHaveBeenCalled())
    const [request] = openBrowserUrlPopoverOverlay.mock.calls.at(-1)!
    expect(request.results).toEqual([
      expect.objectContaining({ kind: 'search', title: 'Search web for "foo bar"' }),
    ])

    fireEvent.submit(view.getByLabelText('Browser controls'))
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith({
      browserTabId: 'native-tab-1',
      url: 'https://www.google.com/search?q=foo%20bar',
    }))
  })

  it('navigates to the selected bookmark from the URL bar', async () => {
    let selectResult: ((resultId: string) => void) | undefined
    openBrowserUrlPopoverOverlay.mockImplementation(async (_request, onSelect) => {
      selectResult = onSelect
      return { update: vi.fn(), close: vi.fn() }
    })
    const view = render(
      <BrowserPane
        paneId="pane-1"
        browserTabId="native-tab-1"
        url="https://example.com"
        active={true}
        bookmarks={[bookmark({ title: 'Docs', url: 'https://example.com/docs' })]}
      />,
    )
    await waitFor(() => expect(api.attachTab).toHaveBeenCalled())
    const input = view.getByLabelText('URL') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'doc' } })
    await waitFor(() => expect(selectResult).toBeTruthy())
    act(() => selectResult?.('bookmark:Docs'))
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith({ browserTabId: 'native-tab-1', url: 'https://example.com/docs' }))
  })

  it('uses exact bookmark matches before treating submitted text as URL or search', async () => {
    const view = render(
      <BrowserPane
        paneId="pane-1"
        browserTabId="native-tab-1"
        url="https://example.com"
        active={true}
        bookmarks={[bookmark({ title: 'foo', url: 'https://example.com/foo' })]}
      />,
    )
    await waitFor(() => expect(api.attachTab).toHaveBeenCalled())
    const input = view.getByLabelText('URL') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    fireEvent.submit(view.getByLabelText('Browser controls'))
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith({ browserTabId: 'native-tab-1', url: 'https://example.com/foo' }))
  })

  it('renders devtools, 1Password, and bookmark controls on the right side of the URL input', async () => {
    const view = render(<BrowserPane paneId="pane-1" workspaceId="workspace-1" browserTabId="native-tab-1" url="https://example.com" active={true} />)
    await waitFor(() => expect(api.attachTab).toHaveBeenCalled())
    const buttons = Array.from(view.getByLabelText('Browser controls').querySelectorAll('button')).map((button) => button.getAttribute('aria-label'))
    expect(buttons).toEqual(['Back', 'Forward', 'Reload', 'Open DevTools', 'Open 1Password', 'Bookmark page'])
  })

  it('opens bookmark creation from star button and shortcut', async () => {
    const view = render(
      <BrowserPane
        paneId="pane-1"
        workspaceId="workspace-1"
        browserTabId="native-tab-1"
        url="https://example.com/docs"
        title="Example Docs"
        faviconDataUrl="data:image/png;base64,abc"
        faviconUrl="https://example.com/favicon.ico"
        active={true}
      />,
    )

    await waitFor(() => expect(api.attachTab).toHaveBeenCalled())
    fireEvent.click(view.getByLabelText('Bookmark page'))
    await waitFor(() => expect(openCreateBookmarkOverlay).toHaveBeenCalledWith({
      initialTitle: 'Example Docs',
      initialUrl: 'https://example.com/docs',
      initialFaviconDataUrl: 'data:image/png;base64,abc',
      initialFaviconUrl: 'https://example.com/favicon.ico',
    }))

    const input = view.getByLabelText('URL')
    fireEvent.keyDown(input, { key: 'd', metaKey: true })
    await waitFor(() => expect(openCreateBookmarkOverlay).toHaveBeenCalledTimes(2))
  })

  it('disables bookmark creation for unbookmarkable URLs', () => {
    const view = render(<BrowserPane paneId="pane-1" workspaceId="workspace-1" browserTabId="native-tab-1" url="about:blank" active={true} />)
    expect(view.getByLabelText('Bookmark page')).toHaveProperty('disabled', true)
  })

  it('does not reattach or refocus a native tab on unrelated parent rerenders', async () => {
    const view = render(
      <BrowserPane paneId="pane-1" browserTabId="native-tab-1" url="https://example.com" active={true} />,
    )

    await waitFor(() => expect(api.attachTab).toHaveBeenCalledTimes(1))
    expect(api.focusTab).toHaveBeenCalledTimes(1)

    view.rerender(
      <BrowserPane
        paneId="pane-1"
        browserTabId="native-tab-1"
        url="https://example.com"
        active={true}
        onBrowserTabId={() => undefined}
      />,
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.attachTab).toHaveBeenCalledTimes(1)
    expect(api.focusTab).toHaveBeenCalledTimes(1)
    expect(api.navigate).not.toHaveBeenCalled()
    expect(api.reload).not.toHaveBeenCalled()
  })

  it('reports native URL changes without navigating on prop sync', async () => {
    let onChange: ((event: { browserTabId: string; patch: Record<string, unknown> }) => void) | undefined
    api.onTabChange.mockImplementation((handler) => {
      onChange = handler
      return () => undefined
    })
    const onUrlChange = vi.fn()
    const onTitleChange = vi.fn()
    const view = render(
      <BrowserPane
        paneId="pane-1"
        browserTabId="native-tab-1"
        url="https://example.com"
        active={true}
        onUrlChange={onUrlChange}
        onTitleChange={onTitleChange}
      />,
    )

    await waitFor(() => expect(api.attachTab).toHaveBeenCalledWith({
      paneId: 'pane-1',
      browserTabId: 'native-tab-1',
    }))

    act(() => {
      onChange?.({
        browserTabId: 'native-tab-1',
        patch: { url: 'https://example.org/docs', title: 'Docs' },
      })
    })

    expect(onUrlChange).toHaveBeenCalledWith('https://example.org/docs')
    expect(onTitleChange).toHaveBeenCalledWith('Docs')
    expect((view.getByLabelText('URL') as HTMLInputElement).value).toBe('https://example.org/docs')

    view.rerender(
      <BrowserPane
        paneId="pane-1"
        browserTabId="native-tab-1"
        url="https://example.org/docs"
        active={true}
        onUrlChange={onUrlChange}
        onTitleChange={onTitleChange}
      />,
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.navigate).not.toHaveBeenCalled()
    expect(api.reload).not.toHaveBeenCalled()
    expect(api.onTabChange).toHaveBeenCalledTimes(1)
  })

  it('reports matching native focus events', async () => {
    let onFocusEvent: ((event: { browserTabId: string }) => void) | undefined
    api.onTabFocus.mockImplementation((handler) => {
      onFocusEvent = handler
      return () => undefined
    })
    const onNativeFocus = vi.fn()

    render(
      <BrowserPane
        paneId="pane-1"
        browserTabId="native-tab-1"
        url="https://example.com"
        active={true}
        onNativeFocus={onNativeFocus}
      />,
    )

    await waitFor(() => expect(api.attachTab).toHaveBeenCalledWith({
      paneId: 'pane-1',
      browserTabId: 'native-tab-1',
    }))

    act(() => {
      onFocusEvent?.({ browserTabId: 'other-tab' })
      onFocusEvent?.({ browserTabId: 'native-tab-1' })
    })

    expect(onNativeFocus).toHaveBeenCalledTimes(1)
  })

  it('reports favicon changes with the current page URL', async () => {
    let onChange: ((event: { browserTabId: string; patch: Record<string, unknown> }) => void) | undefined
    api.onTabChange.mockImplementation((handler) => {
      onChange = handler
      return () => undefined
    })
    const onFaviconChange = vi.fn()
    render(
      <BrowserPane
        paneId="pane-1"
        browserTabId="native-tab-1"
        url="https://example.com"
        active={true}
        onFaviconChange={onFaviconChange}
      />,
    )

    await waitFor(() => expect(api.attachTab).toHaveBeenCalledWith({
      paneId: 'pane-1',
      browserTabId: 'native-tab-1',
    }))

    act(() => {
      onChange?.({
        browserTabId: 'native-tab-1',
        patch: { url: 'https://example.org/docs', favicon: 'https://example.org/favicon.ico' },
      })
    })

    expect(onFaviconChange).toHaveBeenCalledWith({
      pageUrl: 'https://example.org/docs',
      faviconUrl: 'https://example.org/favicon.ico',
    })
  })

  it('replaces a persisted native tab id when the desktop app restarted without that tab', async () => {
    const onBrowserTabId = vi.fn()
    api.attachTab.mockRejectedValueOnce(new Error('tab not found'))
    api.createTab.mockResolvedValueOnce({ browserTabId: 'native-tab-2' })

    render(
      <BrowserPane
        paneId="pane-1"
        browserTabId="stale-native-tab"
        url="https://example.com"
        active={true}
        onBrowserTabId={onBrowserTabId}
      />,
    )

    await waitFor(() => expect(api.createTab).toHaveBeenCalledWith({
      paneId: 'pane-1',
      url: 'https://example.com',
    }))
    expect(api.focusTab).not.toHaveBeenCalledWith({ browserTabId: 'stale-native-tab' })
    expect(onBrowserTabId).toHaveBeenCalledWith('native-tab-2')
  })

  it('can preserve native tabs across React unmounts', async () => {
    const view = render(
      <BrowserPane
        paneId="pane-1"
        browserTabId="native-tab-1"
        url="https://example.com"
        active={true}
        closeOnUnmount={false}
      />,
    )

    await waitFor(() => expect(api.attachTab).toHaveBeenCalledWith({
      paneId: 'pane-1',
      browserTabId: 'native-tab-1',
    }))

    await act(async () => view.unmount())
    expect(api.closeTab).not.toHaveBeenCalled()
  })

  it('renders connected-agent banner and disconnects the agent', async () => {
    api.getAgentConnections.mockResolvedValue({ browserTabIds: ['native-tab-1'] })
    const view = render(
      <BrowserPane paneId="pane-1" browserTabId="native-tab-1" url="https://example.com" active={true} />,
    )

    await waitFor(() => expect(view.getByText('Agent connected to this tab')).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => expect(api.disconnectAgent).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' }))
  })
})
