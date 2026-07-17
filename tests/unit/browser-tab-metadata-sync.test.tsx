// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  onTabChange: vi.fn(),
  getTab: vi.fn(),
  setMetadata: vi.fn(async () => undefined),
  cacheFavicon: vi.fn(async () => undefined),
  invalidateFavicons: vi.fn(async () => undefined),
}))

vi.mock('../../src/lib/browser-api', () => ({
  browserApi: {
    isAvailable: () => true,
    onTabChange: mocks.onTabChange,
    getTab: mocks.getTab,
  },
}))

vi.mock('../../src/data/modules/workspace-tabs', () => ({
  workspaceTabsCollection: {
    useRows: () => mocks.rows,
    getRows: () => mocks.rows,
  },
  setWorkspaceTabBrowserMetadata: mocks.setMetadata,
}))

vi.mock('../../src/trpc', () => ({
  trpc: {
    favicon: {
      cacheFromUrl: { useMutation: () => ({ mutateAsync: mocks.cacheFavicon }) },
    },
    useUtils: () => ({ favicon: { getByOrigins: { invalidate: mocks.invalidateFavicons } } }),
  },
}))

import { BrowserTabMetadataSync } from '../../src/routes/workspace/browser-tab-metadata-sync'

describe('browser tab metadata sync', () => {
  let emitChange: (event: { browserTabId: string; patch: Record<string, unknown> }) => void
  const row = {
    workspaceId: 'workspace-1',
    id: 'tab-1',
    type: 'browser',
    title: 'https://old.test',
    url: 'https://old.test',
    browserTabId: 'native-1',
  }

  beforeEach(() => {
    mocks.rows = [row]
    mocks.onTabChange.mockImplementation((handler) => {
      emitChange = handler
      return vi.fn()
    })
    mocks.getTab.mockResolvedValue({
      browserTabId: 'native-1',
      url: 'https://snapshot.test',
      title: 'Snapshot title',
      favicon: undefined,
      presentation: 'embedded',
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('reconciles the complete native snapshot for an inactive persisted tab', async () => {
    render(<BrowserTabMetadataSync />)

    await waitFor(() => expect(mocks.setMetadata).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      url: 'https://snapshot.test',
      title: 'Snapshot title',
      faviconUrl: null,
    }))
  })

  it('persists later title events without remounting an individual pane', async () => {
    mocks.getTab.mockResolvedValue(null)
    render(<BrowserTabMetadataSync />)

    act(() => emitChange({
      browserTabId: 'native-1',
      patch: { url: 'https://new.test/docs', title: 'New title' },
    }))

    await waitFor(() => expect(mocks.setMetadata).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      url: 'https://new.test/docs',
      title: 'New title',
      faviconUrl: null,
    }))
  })

  it('does not let an in-flight snapshot overwrite a newer event', async () => {
    let resolveSnapshot: (value: unknown) => void = () => undefined
    mocks.getTab.mockReturnValue(new Promise((resolve) => {
      resolveSnapshot = resolve
    }))
    render(<BrowserTabMetadataSync />)

    act(() => emitChange({ browserTabId: 'native-1', patch: { title: 'Newest title' } }))
    resolveSnapshot({
      browserTabId: 'native-1',
      url: 'https://stale.test',
      title: 'Stale title',
    })

    await waitFor(() => expect(mocks.setMetadata).toHaveBeenCalledTimes(1))
    expect(mocks.setMetadata).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      url: 'https://old.test',
      title: 'Newest title',
      faviconUrl: undefined,
    })
  })

  it('caches a favicon against the URL carried by the native event', async () => {
    mocks.getTab.mockResolvedValue(null)
    render(<BrowserTabMetadataSync />)

    act(() => emitChange({
      browserTabId: 'native-1',
      patch: { url: 'https://new.test/docs', favicon: 'https://new.test/favicon.ico' },
    }))

    await waitFor(() => expect(mocks.cacheFavicon).toHaveBeenCalledWith({
      pageOrigin: 'https://new.test',
      iconUrl: 'https://new.test/favicon.ico',
    }))
    expect(mocks.setMetadata).toHaveBeenCalledWith(expect.objectContaining({
      faviconUrl: 'https://new.test/favicon.ico',
    }))
    expect(mocks.invalidateFavicons).toHaveBeenCalled()
  })
})
