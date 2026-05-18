// @vitest-environment jsdom
import React, { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'

const overlayResponseType = vi.hoisted(() => ({ current: 'bookmark-saved' as 'bookmark-saved' | 'closed' | 'confirmed' }))

vi.mock('../../src/lib/browser-api', () => ({
  browserApi: { isAvailable: () => false },
}))

vi.mock('../../src/trpc', () => ({
  makeTrpcClient: () => ({}),
  trpc: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
}))

vi.mock('../../src/routes/internal/overlay-layer', () => ({
  OVERLAY_CHANNEL: 'test-overlay-channel',
  OverlayLayerApp: ({ initialRequest, onResponse }: { initialRequest: { requestId: string }; onResponse: (response: { requestId: string; type: string; bookmarkId?: string }) => void }) => {
    useEffect(() => {
      window.setTimeout(() => {
        if (overlayResponseType.current === 'bookmark-saved') onResponse({ requestId: initialRequest.requestId, type: 'bookmark-saved', bookmarkId: 'bookmark-1' })
        else if (overlayResponseType.current === 'closed') onResponse({ requestId: initialRequest.requestId, type: 'closed' })
        else onResponse({ requestId: initialRequest.requestId, type: 'confirmed' })
      }, 0)
    }, [initialRequest.requestId, onResponse])
    return null
  },
}))

const { openCreateBookmarkOverlay } = await import('../../src/lib/overlay-layer-controller')

describe('openCreateBookmarkOverlay', () => {
  it('resolves bookmark id on save', async () => {
    overlayResponseType.current = 'bookmark-saved'
    await expect(openCreateBookmarkOverlay({ initialUrl: 'https://example.com' })).resolves.toBe('bookmark-1')
  })

  it('resolves null on close', async () => {
    overlayResponseType.current = 'closed'
    await expect(openCreateBookmarkOverlay({ initialUrl: 'https://example.com' })).resolves.toBeNull()
  })

  it('throws on unexpected response', async () => {
    overlayResponseType.current = 'confirmed'
    await expect(openCreateBookmarkOverlay({ initialUrl: 'https://example.com' })).rejects.toThrow('unexpected overlay response: confirmed')
  })
})
