// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  globalChildTabFromWindowTabCreated,
  globalTabFromPaneContent,
  globalTabUpsertInput,
  universalMenuIntentForTabShortcut,
  GlobalTabsSidebarSection,
  nextGlobalTabIdAfterClose,
  universalMenuOpenTargetForShortcut,
  universalMenuScopeForTabShortcut,
  workspaceSidebarRowActive,
} from '../../src/routes/workspace'
import type { WorkspaceTab } from '../../src/routes/workspace/tab-state'

const faviconQueryData: { current: Record<string, unknown> } = { current: {} }

vi.mock('../../src/trpc', () => ({
  makeTrpcClient: () => ({
    query: vi.fn(),
    subscription: vi.fn(() => ({ unsubscribe: vi.fn() })),
  }),
  trpc: {
    favicon: {
      getByOrigins: {
        useQuery: () => ({ data: faviconQueryData.current }),
      },
      cacheFromUrl: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
    },
    workspace: {
      upsertResource: {
        useMutation: () => ({ mutate: vi.fn() }),
      },
      getOrCreateGlobalTabsWorkspace: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
    },
  },
}))

const tabs: WorkspaceTab[] = [
  { id: 'global-a', type: 'browser', url: 'https://example.com/docs', title: 'Example Docs' },
  { id: 'global-b', type: 'browser', url: 'https://second.test', title: 'Browser' },
]

afterEach(() => {
  cleanup()
  faviconQueryData.current = {}
})

describe('global tabs sidebar', () => {
  it('renders global tabs above workspaces without workspace dnd selection ids', () => {
    render(
      <div>
        <GlobalTabsSidebarSection
          destination={{ workspace: { id: 'global-workspace', name: 'Global tabs' }, tabs, activeTabId: null }}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
        <div data-sidebar-dnd-id="workspace:workspace-a">Workspace A</div>
      </div>,
    )

    const globalTab = screen.getByRole('button', { name: 'Example Docs' })
    const workspace = screen.getByText('Workspace A')
    expect(globalTab.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(globalTab.closest('[data-sidebar-dnd-id]')).toBeNull()
  })

  it('selecting a global tab marks only the global tab active and clears workspace active state', () => {
    const onSelect = vi.fn()
    render(
      <GlobalTabsSidebarSection
        destination={{ workspace: { id: 'global-workspace', name: 'Global tabs' }, tabs, activeTabId: 'global-a' }}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Example Docs' }).getAttribute('aria-current')).toBe('page')
    expect(workspaceSidebarRowActive('workspace-a', 'workspace-a', 'global-a')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'second.test' }))
    expect(onSelect).toHaveBeenCalledWith('global-b')
  })

  it('renders cached favicons from the shared origin cache', () => {
    faviconQueryData.current = {
      'https://example.com': [{
        pageOrigin: 'https://example.com',
        iconUrl: 'https://example.com/favicon.ico',
        dataUrl: 'data:image/png;base64,AA==',
        mediaType: 'image/png',
        sizeBytes: 1,
        updatedAt: new Date(),
        lastSeenAt: new Date(),
      }],
    }

    const view = render(
      <GlobalTabsSidebarSection
        destination={{ workspace: { id: 'global-workspace', name: 'Global tabs' }, tabs, activeTabId: null }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==')
  })

  it('renders different selected favicons for tabs on the same origin', () => {
    const sameOriginTabs: WorkspaceTab[] = [
      { id: 'plain', type: 'browser', url: 'https://github.com/issues', title: 'Issues', faviconUrl: 'https://github.com/plain.ico' },
      { id: 'status', type: 'browser', url: 'https://github.com/pulls', title: 'Pulls', faviconUrl: 'https://github.com/status.ico' },
    ]
    const view = render(
      <GlobalTabsSidebarSection
        destination={{ workspace: { id: 'global-workspace', name: 'Global tabs' }, tabs: sameOriginTabs, activeTabId: null }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        faviconRecords={{
          'https://github.com': [
            { pageOrigin: 'https://github.com', iconUrl: 'https://github.com/plain.ico', dataUrl: 'data:image/png;base64,cGxhaW4=', mediaType: 'image/png', sizeBytes: 5, updatedAt: new Date(), lastSeenAt: new Date() },
            { pageOrigin: 'https://github.com', iconUrl: 'https://github.com/status.ico', dataUrl: 'data:image/png;base64,c3RhdHVz', mediaType: 'image/png', sizeBytes: 6, updatedAt: new Date(), lastSeenAt: new Date() },
          ],
        }}
      />,
    )

    expect(Array.from(view.container.querySelectorAll('img'), (image) => image.getAttribute('src'))).toEqual([
      'data:image/png;base64,cGxhaW4=',
      'data:image/png;base64,c3RhdHVz',
    ])
  })

  it('closing the active global tab selects the next tab or returns to the workspace fallback', () => {
    expect(nextGlobalTabIdAfterClose(tabs, 'global-a')).toBe('global-b')
    expect(nextGlobalTabIdAfterClose(tabs, 'global-b')).toBe('global-a')
    expect(nextGlobalTabIdAfterClose([tabs[0]], 'global-a')).toBeNull()
  })

  it('maps Cmd+T to the web scope', () => {
    expect(universalMenuScopeForTabShortcut()).toBe('web')
  })

  it('maps shifted shortcuts and active global tabs to global opens', () => {
    expect(universalMenuOpenTargetForShortcut(true, false)).toBe('global')
    expect(universalMenuOpenTargetForShortcut(false, true)).toBe('global')
    expect(universalMenuOpenTargetForShortcut(false, false)).toBe('workspace')
  })

  it('maps shifted tab shortcut to global intent', () => {
    expect(universalMenuIntentForTabShortcut(true)).toBe('global')
    expect(universalMenuIntentForTabShortcut(false)).toBe('default')
  })

  it('creates global browser tab data from browser pane content only', () => {
    expect(globalTabFromPaneContent({ type: 'browser', url: 'https://example.com/global' })).toMatchObject({
      type: 'browser',
      url: 'https://example.com/global',
      title: 'https://example.com/global',
    })
    expect(globalTabFromPaneContent({ type: 'shell', shellId: 'shell-1' })).toBeNull()
  })

  it('builds global tab upserts for the global-tabs workspace instead of the active workspace', () => {
    const input = globalTabUpsertInput('global-tabs-workspace', { type: 'browser', url: 'https://example.com/global' }, 2)
    expect(input).toMatchObject({
      workspaceId: 'global-tabs-workspace',
      position: 2,
      tab: { type: 'browser', url: 'https://example.com/global' },
    })
    expect(input?.workspaceId).not.toBe('active-user-workspace')
  })

  it('creates global tab data for native child tabs opened from a global tab', () => {
    const child = globalChildTabFromWindowTabCreated(
      [{ ...tabs[0], browserTabId: 'native-parent' }],
      {
        browserTabId: 'native-child',
        windowId: 'window-1',
        openerBrowserTabId: 'native-parent',
        url: 'https://example.com/child',
        title: 'Child page',
        presentation: 'embedded',
      },
    )

    expect(child).toMatchObject({
      type: 'browser',
      url: 'https://example.com/child',
      browserTabId: 'native-child',
      title: 'Child page',
    })
  })

  it('ignores popup, duplicate, and unrelated native child tab events for global tabs', () => {
    const existing = { ...tabs[0], browserTabId: 'native-parent' }
    const event = {
      browserTabId: 'native-child',
      windowId: 'window-1',
      openerBrowserTabId: 'native-parent',
      url: 'https://example.com/child',
      title: 'Child page',
    }

    expect(globalChildTabFromWindowTabCreated([existing], { ...event, presentation: 'popup' })).toBeNull()
    expect(globalChildTabFromWindowTabCreated([{ ...existing, browserTabId: 'native-child' }], event)).toBeNull()
    expect(globalChildTabFromWindowTabCreated([existing], { ...event, openerBrowserTabId: 'other-tab' })).toBeNull()
  })
})
