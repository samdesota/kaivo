// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { makeTrpcClient, trpc } from '../../src/trpc'

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
    git: {
      inspectCheckout: {
        useQuery: () => ({
          data: {
            repository: { root: '/workspace/repo', gitDir: '/workspace/repo/.git', headOid: 'abc', branch: 'main' },
            originUrl: 'git@github.com:acme/repo.git',
            originError: null,
          },
          isLoading: false,
          error: null,
        }),
      },
    },
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
      json: async () => ({ result: { data: { json: {
        id: 'bookmark-1',
        title: 'Example Docs',
        url: 'https://example.com/docs',
        normalizedUrl: 'https://example.com/docs',
        origin: 'https://example.com',
        faviconDataUrl: 'data:image/png;base64,abc',
        faviconUrl: 'https://example.com/favicon.ico',
        createdAt: '2026-05-16T00:00:00Z',
        updatedAt: '2026-05-16T00:00:00Z',
      } } } }),
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
    expect(fetch).toHaveBeenCalledWith('/trpc/bookmarks.upsert', expect.objectContaining({ method: 'POST' }))
  })

  it('keeps bookmark save disabled for search-like URLs', () => {
    render(
      <OverlayLayerApp
        initialRequest={{
          requestId: 'bookmark-request',
          type: 'create-bookmark',
          initialTitle: 'Search',
          initialUrl: 'foo bar',
        }}
        onResponse={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  })

  it('renders typed task completion metadata and returns cancel and confirm responses', () => {
    const task = {
      deliveryMode: 'pull_request' as const,
      branchName: 'task/parser',
      worktreePath: '/tmp/parser',
      delivery: { pullRequestUrl: null, headCommit: 'abc123', summary: 'Parser ready' },
      completedAt: null,
    }
    const cancelled = vi.fn()
    const first = render(<OverlayLayerApp initialRequest={{
      requestId: 'complete-cancel', type: 'complete-orchestration-task', title: 'Parser', task,
      env: { id: 'env', kind: 'local', url: 'http://env.test', label: 'Env' }, envToken: 'token',
    }} onResponse={cancelled} />)
    expect(screen.getByText(/no PR URL has been reported/)).toBeTruthy()
    expect(screen.getByText('Parser ready')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelled).toHaveBeenCalledWith({ requestId: 'complete-cancel', type: 'orchestration-task-completion', confirmed: false })
    first.unmount()

    const confirmed = vi.fn()
    render(<OverlayLayerApp initialRequest={{
      requestId: 'complete-confirm', type: 'complete-orchestration-task', title: 'Parser', task,
      env: { id: 'env', kind: 'local', url: 'http://env.test', label: 'Env' }, envToken: 'token',
    }} onResponse={confirmed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }))
    expect(confirmed).toHaveBeenCalledWith({ requestId: 'complete-confirm', type: 'orchestration-task-completion', confirmed: true })
  })

  it('offers an existing config detected from the current Git checkout', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('repoConfig.list')) {
        return new Response(JSON.stringify([{ result: { data: { json: [{
            id: 'config-1', name: 'repo', source: 'url', originUrl: 'git@github.com:acme/repo.git',
            ref: null, githubFullName: null, fileCount: 0,
            createdAt: '2026-05-16T00:00:00Z', updatedAt: '2026-05-16T00:00:00Z',
          }] } } }]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const onResponse = vi.fn()
    const queryClient = new QueryClient()
    const client = makeTrpcClient()
    render(
      <QueryClientProvider client={queryClient}>
        <trpc.Provider client={client as never} queryClient={queryClient}>
          <OverlayLayerApp initialRequest={{
            requestId: 'configure-repo', type: 'configure-repository', cwd: '/workspace/repo/packages/app',
            env: { id: 'env', kind: 'local', url: 'http://env.test', label: 'Env' }, envToken: 'token',
          }} onResponse={onResponse} />
        </trpc.Provider>
      </QueryClientProvider>,
    )

    expect(await screen.findByText(/matches the existing repo config/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use config' }))
    expect(onResponse).toHaveBeenCalledWith({
      requestId: 'configure-repo', type: 'repo-config-created', configId: 'config-1',
    })
  })

  it('accepts configure-repository requests from the detached overlay channel', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('repoConfig.list')) {
        return new Response(JSON.stringify([{ result: { data: { json: [] } } }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const queryClient = new QueryClient()
    const client = makeTrpcClient()
    render(
      <QueryClientProvider client={queryClient}>
        <trpc.Provider client={client as never} queryClient={queryClient}>
          <OverlayLayerApp />
        </trpc.Provider>
      </QueryClientProvider>,
    )
    const sender = new BroadcastChannel(OVERLAY_CHANNEL)

    await act(async () => {
      sender.postMessage({
        requestId: 'configure-repo-channel',
        type: 'configure-repository',
        cwd: '/workspace/repo',
        env: { id: 'env', kind: 'local', url: 'http://env.test', label: 'Env' },
        envToken: 'token',
      })
    })

    expect(await screen.findByText('Configure repository for subtasks')).toBeTruthy()
    expect(screen.getAllByText('/workspace/repo')).not.toHaveLength(0)
  })

  it('copies an OpenAI device code before continuing', async () => {
    const onResponse = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(<OverlayLayerApp initialRequest={{
      requestId: 'openai-device-code',
      type: 'openai-device-code',
      deviceCode: 'ABCD-EFGH',
    }} onResponse={onResponse} />)

    expect(screen.getByText('ABCD-EFGH')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCD-EFGH'))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Continue to OpenAI' }))
    expect(onResponse).toHaveBeenCalledWith({
      requestId: 'openai-device-code',
      type: 'openai-device-code-result',
      continued: true,
    })
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
