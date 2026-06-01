// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  globalTabFromPaneContent,
  globalTabUpsertInput,
  GlobalTabsSidebarSection,
  nextGlobalTabIdAfterClose,
  universalMenuIntentForTabShortcut,
  workspaceSidebarRowActive,
} from '../../src/routes/workspace'
import type { WorkspaceTab } from '../../src/routes/workspace/tab-state'

vi.mock('../../src/trpc', () => ({
  makeTrpcClient: () => ({
    query: vi.fn(),
    subscription: vi.fn(() => ({ unsubscribe: vi.fn() })),
  }),
  trpc: {
    favicon: {
      getByOrigins: {
        useQuery: () => ({ data: {} }),
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

afterEach(() => cleanup())

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

  it('closing the active global tab selects the next tab or returns to the workspace fallback', () => {
    expect(nextGlobalTabIdAfterClose(tabs, 'global-a')).toBe('global-b')
    expect(nextGlobalTabIdAfterClose(tabs, 'global-b')).toBe('global-a')
    expect(nextGlobalTabIdAfterClose([tabs[0]], 'global-a')).toBeNull()
  })

  it('maps Cmd+Shift+T to new-workspace modal intent metadata', () => {
    expect(universalMenuIntentForTabShortcut(true)).toBe('new-workspace')
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
})
