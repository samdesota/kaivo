// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
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
  NewAgentChatOverlay: () => <div>new agent chat</div>,
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
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      value: TestBroadcastChannel,
      configurable: true,
    })
  })

  afterEach(() => cleanup())

  it('ignores overlay response messages received on the request channel', async () => {
    render(<OverlayLayerApp />)
    const sender = new BroadcastChannel(OVERLAY_CHANNEL)

    await act(async () => {
      sender.postMessage({ requestId: 'overlay-test', type: 'closed' })
    })

    expect(document.body.textContent).not.toContain('new agent chat')
  })
})
