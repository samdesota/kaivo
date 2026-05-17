// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type BroadcastHandler = ((event: MessageEvent) => void) | null

const channels = new Map<string, Set<TestBroadcastChannel>>()

class TestBroadcastChannel {
  onmessage: BroadcastHandler = null
  private closed = false

  constructor(public name: string) {
    const set = channels.get(name) ?? new Set<TestBroadcastChannel>()
    set.add(this)
    channels.set(name, set)
  }

  postMessage(data: unknown) {
    for (const channel of channels.get(this.name) ?? []) {
      if (channel === this || channel.closed) continue
      channel.onmessage?.({ data } as MessageEvent)
    }
  }

  close() {
    this.closed = true
    channels.get(this.name)?.delete(this)
  }
}

vi.mock('../../src/env-trpc', () => ({
  envTrpc: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
  makeManagedEnvReactClient: () => ({ client: {}, close: vi.fn() }),
}))

vi.mock('../../src/routes/env/agent/new-agent-chat-modal', () => ({
  NewAgentChatOverlay: ({ initialWorkspaceMode = 'existing', onClose }: { initialWorkspaceMode?: string; onClose: () => void }) => {
    const [mode] = React.useState(initialWorkspaceMode)
    return <button onClick={onClose}>new agent chat {mode}</button>
  },
}))

vi.mock('../../src/routes/env/agent/folder-picker-modal', () => ({
  FolderPickerModal: () => <div>folder picker</div>,
}))

vi.mock('../../src/routes/env/shell/command-palette', () => ({
  CommandPalette: () => <div>command palette</div>,
}))

const { OVERLAY_CHANNEL, OverlayLayerApp } = await import('../../src/routes/internal/overlay-layer')

describe('OverlayLayerApp', () => {
  beforeEach(() => {
    channels.clear()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { json: { id: 'bookmark-1' } } } }),
    })))
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      value: TestBroadcastChannel,
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('ignores overlay response messages received on the request channel', async () => {
    render(<OverlayLayerApp />)
    const sender = new BroadcastChannel(OVERLAY_CHANNEL)

    await act(async () => {
      sender.postMessage({ requestId: 'overlay-test', type: 'closed' })
    })

    expect(document.body.textContent).not.toContain('new agent chat')
  })

  it('clears request-scoped modal state after an overlay response', async () => {
    render(<OverlayLayerApp />)
    const sender = new BroadcastChannel(OVERLAY_CHANNEL)

    await act(async () => {
      sender.postMessage({
        requestId: 'overlay-one',
        type: 'new-agent-chat',
        initialWorkspaceMode: 'new',
        env: { id: 'env', kind: 'local', url: 'http://env.test', label: 'Env' },
        envToken: 'token',
      })
    })
    expect(document.body.textContent).toContain('new agent chat new')

    await act(async () => {
      document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.body.textContent).not.toContain('new agent chat')

    await act(async () => {
      sender.postMessage({
        requestId: 'overlay-two',
        type: 'new-agent-chat',
        initialWorkspaceMode: 'existing',
        workspaceId: 'workspace-1',
        env: { id: 'env', kind: 'local', url: 'http://env.test', label: 'Env' },
        envToken: 'token',
      })
    })

    expect(document.body.textContent).toContain('new agent chat existing')
  })

  it('renders create bookmark requests and responds with saved bookmark id', async () => {
    const onResponse = vi.fn()
    render(
      <OverlayLayerApp
        initialRequest={{
          requestId: 'bookmark-request',
          type: 'create-bookmark',
          workspaceId: 'workspace-1',
          initialTitle: 'Example Docs',
          initialUrl: 'https://example.com/docs',
          initialFaviconDataUrl: 'data:image/png;base64,abc',
          initialFaviconUrl: 'https://example.com/favicon.ico',
        }}
        onResponse={onResponse}
      />,
    )

    expect(screen.getByText('Save bookmark')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onResponse).toHaveBeenCalledWith({
      requestId: 'bookmark-request',
      type: 'bookmark-saved',
      bookmarkId: 'bookmark-1',
    }))
    expect(fetch).toHaveBeenCalledWith('/trpc/workspace.upsertResource', expect.objectContaining({ method: 'POST' }))
  })

  it('keeps bookmark save disabled for search-like URLs', () => {
    render(
      <OverlayLayerApp
        initialRequest={{
          requestId: 'bookmark-request',
          type: 'create-bookmark',
          workspaceId: 'workspace-1',
          initialTitle: 'Search',
          initialUrl: 'foo bar',
        }}
        onResponse={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  })

  it('renders browser URL popover requests and responds with selected result id', () => {
    const onResponse = vi.fn()
    render(
      <OverlayLayerApp
        initialRequest={{
          requestId: 'url-popover-request',
          type: 'browser-url-popover',
          anchor: { left: 8, top: 32, width: 240 },
          activeIndex: 0,
          results: [
            { id: 'bookmark:docs', kind: 'bookmark', title: 'Docs', detail: 'example.com', iconUrl: 'data:image/png;base64,abc' },
            { id: 'search:doc', kind: 'search', title: 'Search web for "doc"' },
          ],
        }}
        onResponse={onResponse}
      />,
    )

    expect(screen.getByRole('listbox', { name: 'URL bar results' })).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('option', { name: /Docs/ }))
    expect(onResponse).toHaveBeenCalledWith({
      requestId: 'url-popover-request',
      type: 'browser-url-popover-selected',
      resultId: 'bookmark:docs',
    })
  })
})
