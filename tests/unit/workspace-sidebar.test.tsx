// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    folder: { id: 'folder-cloud', name: 'Zoottle', position: 0, collapsed: false },
    children: [
      { type: 'workspace', workspace: { id: 'workspace-tools', name: 'zoottle-app', position: 0 } },
      {
        type: 'folder',
        folder: { id: 'folder-packages', name: 'Packages', position: 1, collapsed: false },
        children: [{ type: 'workspace', workspace: { id: 'workspace-plugin', name: 'opencode-plugin', position: 0 } }],
      },
    ],
  },
]

const moveSidebarNodeMock = vi.hoisted(() => vi.fn())
const notificationDismissMock = vi.hoisted(() => vi.fn())
const notificationDismissForSessionMock = vi.hoisted(() => vi.fn())
const notificationListData = vi.hoisted(() => [] as Array<{
  id: string
  workspaceId: string
  sessionId: string
  kind: 'finished' | 'question' | 'permission' | 'error'
  title: string
  summary: string
  createdAt: Date
}>)

vi.mock('../../src/routes/workspace/context', () => ({
  useWorkspaceContext: () => ctx,
  WorkspaceContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../src/trpc', () => ({
  trpc: {
    workspace: {
      listTree: { useQuery: () => ({ data: treeData }) },
      list: { useQuery: () => ({ data: [{ id: 'workspace-tools', name: 'zoottle-app' }] }) },
      create: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
      createFolder: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      rename: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      archive: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      archiveFolder: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      deleteResource: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      setFolderCollapsed: { useMutation: () => ({ mutate: vi.fn() }) },
      moveSidebarNode: { useMutation: () => ({ mutateAsync: moveSidebarNodeMock }) },
    },
    sync: {
      changes: { useSubscription: () => undefined },
    },
  },
}))

vi.mock('../../src/env-trpc', () => ({
  makeEnvReactClient: () => ({}),
  makeManagedEnvReactClient: () => ({ client: {} }),
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

vi.mock('../../src/routes/env/env-context', () => ({
  EnvContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useEnv: () => ({
    env: { id: 'env-1', url: 'http://env', label: 'Local' },
    envToken: 'token',
  }),
}))

vi.mock('../../src/routes/workspace/notifications-store', () => ({
  useAgentNotificationsStore: () => ({
    records: notificationListData,
    dismiss: notificationDismissMock,
    dismissForSession: notificationDismissForSessionMock,
  }),
}))

vi.mock('../../src/lib/trpc-plain', () => ({
  appTrpcMutation: vi.fn(),
  appTrpcQuery: vi.fn(async () => ({ table: 'workspace_resources', rows: [], seq: 0 })),
  trpcQueryKey: (path: string) => [path],
}))

vi.mock('../../src/routes/env/agent/new-agent-chat-modal', () => ({
  NewAgentChatOverlayLauncher: ({ open, initialWorkspaceMode, workspaceName }: { open: boolean; initialWorkspaceMode?: string; workspaceName?: string }) =>
    open ? (
      <div>
        <label>
          Workspace mode
          <select aria-label="Workspace mode" value={initialWorkspaceMode ?? 'existing'} onChange={() => undefined}>
            <option value="new">new</option>
            <option value="existing">existing</option>
          </select>
        </label>
        {workspaceName && <span>{workspaceName}</span>}
      </div>
    ) : null,
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
  ctx.uiState.activeAgentSessionId = null
  ctx.localEnvTarget = null
  moveSidebarNodeMock.mockReset()
  moveSidebarNodeMock.mockResolvedValue([])
  notificationDismissMock.mockReset()
  notificationDismissForSessionMock.mockReset()
  notificationListData.length = 0
  window.localStorage.clear()
  window.scrollTo = vi.fn()
})

afterEach(() => cleanup())

describe('WorkspaceSidebar', () => {
  it('renders folders, nested folders, and workspaces from the tree', async () => {
    renderSidebar()

    expect((await screen.findAllByText('Zoottle')).length).toBeGreaterThan(0)
    expect(screen.getByText('zoottle-app')).toBeTruthy()
    expect(screen.getByText('Packages')).toBeTruthy()
    expect(screen.getByText('opencode-plugin')).toBeTruthy()
  })

  it('opens the new agent chat modal in new-workspace mode from a folder plus', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    renderSidebar()

    fireEvent.click(await screen.findByRole('button', { name: 'Create workspace in Zoottle' }))

    const select = await screen.findByLabelText('Workspace mode') as HTMLSelectElement
    expect(select.value).toBe('new')
  })

  it('opens the new agent chat modal in existing-workspace mode from a workspace plus', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    renderSidebar()

    fireEvent.click(await screen.findByRole('button', { name: 'Create chat in zoottle-app' }))

    const select = await screen.findByLabelText('Workspace mode') as HTMLSelectElement
    expect(select.value).toBe('existing')
    expect(screen.getAllByText('zoottle-app').length).toBeGreaterThan(0)
  })

  it('does not expose workspace chat expansion controls', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    renderSidebar()

    expect(await screen.findByText('zoottle-app')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Expand chats for zoottle-app' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse chats for zoottle-app' })).toBeNull()

    expect(window.localStorage.getItem('cloud-code.workspaceChatExpanded')).toBeNull()
    expect(screen.queryByText('No chats')).toBeNull()
  })

  it('renders chat finish notifications with workspace names', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    notificationListData.push({
      id: 'notification-1',
      workspaceId: 'workspace-tools',
      sessionId: 'session-1',
      kind: 'finished',
      title: 'Build notifications',
      summary: 'Implemented notifications',
      createdAt: new Date('2026-05-08T12:00:00Z'),
    })

    renderSidebar()

    expect(await screen.findByText('Notifications')).toBeTruthy()
    expect(screen.getByText('Build notifications')).toBeTruthy()
    expect(screen.getByText('Implemented notifications')).toBeTruthy()
    expect(screen.getAllByText('zoottle-app').length).toBeGreaterThan(1)
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss notification Build notifications' })).toBeTruthy()
  })

  it('clears and dismisses notifications from sidebar controls', async () => {
    notificationListData.push(
      {
        id: 'notification-1',
        workspaceId: 'workspace-tools',
        sessionId: 'session-1',
        kind: 'finished',
        title: 'Build notifications',
        summary: 'Implemented notifications',
        createdAt: new Date('2026-05-08T12:00:00Z'),
      },
      {
        id: 'notification-2',
        workspaceId: 'workspace-tools',
        sessionId: 'session-2',
        kind: 'permission',
        title: 'Fix realtime',
        summary: 'Realtime updates now appear immediately.',
        createdAt: new Date('2026-05-08T12:01:00Z'),
      },
    )

    renderSidebar()

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss notification Build notifications' }))
    expect(notificationDismissMock).toHaveBeenCalledWith('notification-1')

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(notificationDismissMock).toHaveBeenCalledWith('notification-2')
  })

  it('does not render notifications for the active chat', async () => {
    ctx.uiState.activeAgentSessionId = 'session-1'
    notificationListData.push({
      id: 'notification-1',
      workspaceId: 'workspace-tools',
      sessionId: 'session-1',
      kind: 'finished',
      title: 'Build notifications',
      summary: 'Implemented notifications',
      createdAt: new Date('2026-05-08T12:00:00Z'),
    })

    renderSidebar()

    expect(screen.queryByText('Implemented notifications')).toBeNull()
    await waitFor(() => expect(notificationDismissForSessionMock).toHaveBeenCalledWith('session-1'))
  })

  it('renders folder and workspace rows as separate whole-row draggable targets', async () => {
    renderSidebar()

    const workspaceRow = (await screen.findByText('zoottle-app')).closest('[role="button"]') as HTMLElement
    const folderRow = screen.getByText('Packages').closest('[role="button"]') as HTMLElement

    expect(workspaceRow).toBeTruthy()
    expect(folderRow).toBeTruthy()
    expect(workspaceRow).not.toBe(folderRow)
    expect(workspaceRow.getAttribute('aria-roledescription')).toBe('sortable')
    expect(folderRow.getAttribute('aria-roledescription')).toBe('sortable')
    expect(workspaceRow.textContent).toContain('zoottle-app')
    expect(workspaceRow.textContent).not.toContain('Packages')
  })
})
