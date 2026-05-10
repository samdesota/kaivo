// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSidebar } from '../../src/routes/workspace'

const ctx = {
  workspace: { id: 'workspace-active', name: 'Active workspace' },
  uiState: { activeAgentSessionId: null },
  localEnvTarget: null as null | { available: boolean; token?: string; env: { id: string; url: string; label: string } },
}

const treeData = [
  {
    type: 'folder',
    folder: { id: 'folder-cloud', name: 'Cloud Code', position: 0, collapsed: false },
    children: [
      { type: 'workspace', workspace: { id: 'workspace-tools', name: 'cloud-code-tools', position: 0 } },
      {
        type: 'folder',
        folder: { id: 'folder-packages', name: 'Packages', position: 1, collapsed: false },
        children: [{ type: 'workspace', workspace: { id: 'workspace-plugin', name: 'opencode-plugin', position: 0 } }],
      },
    ],
  },
]

const moveSidebarNodeMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/routes/workspace/context', () => ({
  useWorkspaceContext: () => ctx,
  WorkspaceContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../src/trpc', () => ({
  trpc: {
    workspace: {
      listTree: { useQuery: () => ({ data: treeData }) },
      list: { useQuery: () => ({ data: [{ id: 'workspace-tools', name: 'cloud-code-tools' }] }) },
      create: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
      createFolder: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      rename: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      archive: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      setFolderCollapsed: { useMutation: () => ({ mutate: vi.fn() }) },
      moveSidebarNode: { useMutation: () => ({ mutateAsync: moveSidebarNodeMock }) },
    },
  },
}))

vi.mock('../../src/env-trpc', () => ({
  makeEnvReactClient: () => ({}),
  envTrpc: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    repo: {
      listRecentFolders: { useQuery: () => ({ data: [] }) },
      listConfigs: { useQuery: () => ({ data: [] }) },
      listWorktrees: { useQuery: () => ({ data: [] }) },
      cloneConfig: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
      deleteWorktree: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
    },
    agent: {
      sessionList: { useQuery: () => ({ data: [] }) },
      workspaceChatSummary: { useQuery: () => ({ data: [] }) },
      sessionStart: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
    },
    fs: {
      browseHome: { useQuery: () => ({ data: { path: '/tmp', parent: null, dirs: [] }, error: null }) },
    },
  },
}))

function renderSidebar() {
  const rootRoute = createRootRoute()
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$workspaceId',
    component: () => <WorkspaceSidebar dispatchWorkspaceState={vi.fn()} onHide={vi.fn()} />,
    validateSearch: () => ({ chat: undefined as string | undefined, tab: undefined as string | undefined }),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/w/workspace-active'] }),
  })
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  ctx.localEnvTarget = null
  moveSidebarNodeMock.mockReset()
  moveSidebarNodeMock.mockResolvedValue([])
  window.localStorage.clear()
  window.scrollTo = vi.fn()
})

afterEach(() => cleanup())

describe('WorkspaceSidebar', () => {
  it('renders folders, nested folders, and workspaces from the tree', async () => {
    renderSidebar()

    expect((await screen.findAllByText('Cloud Code')).length).toBeGreaterThan(0)
    expect(screen.getByText('cloud-code-tools')).toBeTruthy()
    expect(screen.getByText('Packages')).toBeTruthy()
    expect(screen.getByText('opencode-plugin')).toBeTruthy()
  })

  it('opens the new agent chat modal in new-workspace mode from a folder plus', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    renderSidebar()

    fireEvent.click(await screen.findByRole('button', { name: 'Create workspace in Cloud Code' }))

    const select = await screen.findByLabelText('Workspace mode') as HTMLSelectElement
    expect(select.value).toBe('new')
  })

  it('opens the new agent chat modal in existing-workspace mode from a workspace plus', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    renderSidebar()

    fireEvent.click(await screen.findByRole('button', { name: 'Create chat in cloud-code-tools' }))

    const select = await screen.findByLabelText('Workspace mode') as HTMLSelectElement
    expect(select.value).toBe('existing')
    expect(screen.getAllByText('cloud-code-tools').length).toBeGreaterThan(1)
  })

  it('persists workspace chat expansion state', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    renderSidebar()

    fireEvent.click(await screen.findByRole('button', { name: 'Expand chats for cloud-code-tools' }))

    expect(JSON.parse(window.localStorage.getItem('cloud-code.workspaceChatExpanded') ?? '[]')).toEqual(['workspace-tools'])
    expect(await screen.findByText('No chats')).toBeTruthy()
  })

  it('renders folder and workspace rows as separate whole-row draggable targets', async () => {
    renderSidebar()

    const workspaceRow = (await screen.findByText('cloud-code-tools')).closest('[role="button"]') as HTMLElement
    const folderRow = screen.getByText('Packages').closest('[role="button"]') as HTMLElement

    expect(workspaceRow).toBeTruthy()
    expect(folderRow).toBeTruthy()
    expect(workspaceRow).not.toBe(folderRow)
    expect(workspaceRow.getAttribute('aria-roledescription')).toBe('sortable')
    expect(folderRow.getAttribute('aria-roledescription')).toBe('sortable')
    expect(workspaceRow.textContent).toContain('cloud-code-tools')
    expect(workspaceRow.textContent).not.toContain('Packages')
  })
})
