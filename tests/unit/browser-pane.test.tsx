// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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
  getAgentConnections: vi.fn(async () => ({ browserTabIds: [] })),
  disconnectAgent: vi.fn(async () => undefined),
  closeTab: vi.fn(async () => undefined),
  setSlot: vi.fn(async () => undefined),
  onTabChange: vi.fn(() => () => undefined),
}

vi.mock('../../src/lib/browser-api', () => ({
  browserApi: api,
}))

class TestResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

const { BrowserPane } = await import('../../src/components/browser-pane')
let rect = { x: 10, y: 20, width: 300, height: 200 }

describe('BrowserPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.onTabChange.mockReturnValue(() => undefined)
    api.isAvailable.mockReturnValue(true)
    api.getAgentConnections.mockResolvedValue({ browserTabIds: [] })
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
    expect(api.back).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
    expect(api.forward).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
    expect(api.reload).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
    expect(api.openDevTools).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })

    const input = view.getByLabelText('URL') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'example.org/path' } })
    fireEvent.submit(view.getByLabelText('Browser controls'))
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith({
      browserTabId: 'native-tab-1',
      url: 'https://example.org/path',
    }))
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
