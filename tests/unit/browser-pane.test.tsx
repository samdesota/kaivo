// @vitest-environment jsdom
import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = {
  isAvailable: vi.fn(() => true),
  createTab: vi.fn(async () => ({ browserTabId: 'native-tab-1' })),
  attachTab: vi.fn(async () => undefined),
  focusTab: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
  back: vi.fn(async () => undefined),
  forward: vi.fn(async () => undefined),
  reload: vi.fn(async () => undefined),
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
    api.isAvailable.mockReturnValue(true)
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
    await waitFor(() => expect(api.attachTab).toHaveBeenCalledWith({
      paneId: 'pane-1',
      browserTabId: 'native-tab-1',
    }))
    expect(api.focusTab).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })

    await act(async () => view.unmount())
    expect(api.closeTab).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
  })

  it('renders an unavailable state outside Electron', () => {
    api.isAvailable.mockReturnValue(false)
    const view = render(<BrowserPane paneId="pane-1" active={true} />)
    expect(view.getByText('Browser pane unavailable')).toBeTruthy()
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
    expect(api.back).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
    expect(api.forward).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })
    expect(api.reload).toHaveBeenCalledWith({ browserTabId: 'native-tab-1' })

    const input = view.getByLabelText('URL') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'example.org/path' } })
    fireEvent.submit(view.getByLabelText('Browser controls'))
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith({
      browserTabId: 'native-tab-1',
      url: 'https://example.org/path',
    }))
  })
})
