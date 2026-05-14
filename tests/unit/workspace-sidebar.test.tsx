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
    folder: { id: 'folder-cloud', name: 'Kaivo', position: 0, collapsed: false },
    children: [
      { type: 'workspace', workspace: { id: 'workspace-tools', name: 'kaivo-app', folderId: 'folder-cloud', position: 0 } },
      { type: 'workspace', workspace: { id: 'workspace-docs', name: 'docs-app', folderId: 'folder-cloud', position: 1 } },
      {
        type: 'folder',
        folder: { id: 'folder-packages', name: 'Packages', position: 2, collapsed: false },
        children: [{ type: 'workspace', workspace: { id: 'workspace-plugin', name: 'opencode-plugin', folderId: 'folder-packages', position: 0 } }],
      },
    ],
  },
]

const moveSidebarNodeMock = vi.hoisted(() => vi.fn())
const createFolderMock = vi.hoisted(() => vi.fn())
const renameFolderMock = vi.hoisted(() => vi.fn())
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
const agentSessionListData = vi.hoisted(() => [] as Array<{
  id: string
  workspaceId: string | null
  status: 'active' | 'archived'
  lastActivityAt: Date | string
}>)
const agentRuntimeData = vi.hoisted(() => [] as Array<{
  sessionId: string
  workspaceId: string | null
  running: boolean
  pendingAttentionCount: number
  lastActivityAt: Date
  updatedAt: Date
}>)

vi.mock('../../src/routes/workspace/context', () => ({
  useWorkspaceContext: () => ctx,
  WorkspaceContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../src/trpc', () => ({
  trpc: {
    workspace: {
      listTree: { useQuery: () => ({ data: treeData }) },
      list: { useQuery: () => ({ data: [{ id: 'workspace-tools', name: 'kaivo-app' }] }) },
      create: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
      createFolder: { useMutation: () => ({ isPending: false, mutateAsync: createFolderMock }) },
      rename: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      renameFolder: { useMutation: () => ({ mutateAsync: renameFolderMock }) },
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
      sessionList: { useQuery: () => ({ data: agentSessionListData }) },
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

vi.mock('../../src/routes/workspace/agent-runtime-store', () => ({
  useAgentRuntimeStore: (workspaceId: string) => ({
    records: agentRuntimeData.filter((record) => record.workspaceId === workspaceId),
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
  ctx.workspace = { id: 'workspace-active', name: 'Active workspace' }
  ctx.uiState.activeAgentSessionId = null
  ctx.localEnvTarget = null
  moveSidebarNodeMock.mockReset()
  moveSidebarNodeMock.mockResolvedValue([])
  createFolderMock.mockReset()
  createFolderMock.mockResolvedValue({ id: 'folder-new', name: 'New folder', position: 0, collapsed: false })
  renameFolderMock.mockReset()
  renameFolderMock.mockResolvedValue({ id: 'folder-cloud', name: 'Renamed folder', position: 0, collapsed: false })
  notificationDismissMock.mockReset()
  notificationDismissForSessionMock.mockReset()
  notificationListData.length = 0
  agentSessionListData.length = 0
  agentRuntimeData.length = 0
  window.localStorage.clear()
  window.scrollTo = vi.fn()
})

afterEach(() => cleanup())

describe('WorkspaceSidebar', () => {
  it('renders folders, nested folders, and workspaces from the tree', async () => {
    renderSidebar()

    expect((await screen.findAllByText('Kaivo')).length).toBeGreaterThan(0)
    expect(screen.getByText('kaivo-app')).toBeTruthy()
    expect(screen.getByText('Packages')).toBeTruthy()
    expect(screen.getByText('opencode-plugin')).toBeTruthy()
  })

  it('opens the new agent chat modal in new-workspace mode from a folder plus', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    renderSidebar()

    fireEvent.click(await screen.findByRole('button', { name: 'Create workspace in Kaivo' }))

    const select = await screen.findByLabelText('Workspace mode') as HTMLSelectElement
    expect(select.value).toBe('new')
  })

  it('does not render workspace row plus buttons', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    renderSidebar()

    expect(await screen.findByText('kaivo-app')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create chat in kaivo-app' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create workspace in Kaivo' })).toBeTruthy()
  })

  it('does not expose workspace chat expansion controls', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    renderSidebar()

    expect(await screen.findByText('kaivo-app')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Expand chats for kaivo-app' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse chats for kaivo-app' })).toBeNull()

    expect(window.localStorage.getItem('cloud-code.workspaceChatExpanded')).toBeNull()
    expect(screen.queryByText('No chats')).toBeNull()
  })

  it('renders realtime running state from agent runtime records', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    agentSessionListData.push({
      id: 'session-1',
      workspaceId: 'workspace-tools',
      status: 'active',
      lastActivityAt: '2026-05-10T12:00:00.000Z',
    })
    agentRuntimeData.push({
      sessionId: 'session-1',
      workspaceId: 'workspace-tools',
      running: true,
      pendingAttentionCount: 0,
      lastActivityAt: new Date('2026-05-10T12:01:00.000Z'),
      updatedAt: new Date('2026-05-10T12:01:00.000Z'),
    })

    renderSidebar()

    expect(await screen.findByLabelText('Chat running')).toBeTruthy()
  })

  it('renders finished-chat dot for inactive workspace with unread runtime activity', async () => {
    ctx.localEnvTarget = { available: true, token: 'token', env: { id: 'env-1', url: 'http://env', label: 'Local' } }
    window.localStorage.setItem('cloud-code.workspaceChatReadAt', JSON.stringify({ 'workspace-tools': new Date('2026-05-10T12:00:00.000Z').getTime() }))
    agentSessionListData.push({
      id: 'session-1',
      workspaceId: 'workspace-tools',
      status: 'active',
      lastActivityAt: '2026-05-10T12:00:00.000Z',
    })
    agentRuntimeData.push({
      sessionId: 'session-1',
      workspaceId: 'workspace-tools',
      running: false,
      pendingAttentionCount: 0,
      lastActivityAt: new Date('2026-05-10T12:01:00.000Z'),
      updatedAt: new Date('2026-05-10T12:01:00.000Z'),
    })

    renderSidebar()

    expect(await screen.findByLabelText('New chat response')).toBeTruthy()
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
    expect(screen.getAllByText('kaivo-app').length).toBeGreaterThan(1)
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

    const workspaceRow = (await screen.findByText('kaivo-app')).closest('[role="button"]') as HTMLElement
    const folderRow = screen.getByText('Packages').closest('[role="button"]') as HTMLElement

    expect(workspaceRow).toBeTruthy()
    expect(folderRow).toBeTruthy()
    expect(workspaceRow).not.toBe(folderRow)
    expect(workspaceRow.getAttribute('aria-roledescription')).toBe('sortable')
    expect(folderRow.getAttribute('aria-roledescription')).toBe('sortable')
    expect(workspaceRow.textContent).toContain('kaivo-app')
    expect(workspaceRow.textContent).not.toContain('Packages')
  })

  it('renames folders inline and disables drag handles while editing', async () => {
    renderSidebar()

    fireEvent.doubleClick(await screen.findByText('Kaivo'))

    const input = await screen.findByLabelText('Folder name') as HTMLInputElement
    expect(input.value).toBe('Kaivo')
    expect(screen.getByText('kaivo-app').closest('[role="button"]')).toBeNull()

    fireEvent.change(input, { target: { value: 'Renamed folder' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(renameFolderMock).toHaveBeenCalledWith({ id: 'folder-cloud', name: 'Renamed folder' }))
  })

  it('groups all cmd-selected sibling workspaces into a new folder', async () => {
    renderSidebar()

    fireEvent.click(await screen.findByText('kaivo-app'), { metaKey: true })
    fireEvent.click(await screen.findByText('docs-app'), { metaKey: true })
    fireEvent.keyDown(window, { key: 'g', metaKey: true })

    await waitFor(() => expect(createFolderMock).toHaveBeenCalledWith({ name: 'New folder', parentId: 'folder-cloud' }))
    await waitFor(() => expect(moveSidebarNodeMock).toHaveBeenCalledWith({
      nodeType: 'workspace',
      nodeId: 'workspace-tools',
      parentFolderId: 'folder-new',
      beforeNodeId: null,
    }))
    expect(moveSidebarNodeMock).toHaveBeenCalledWith({
      nodeType: 'workspace',
      nodeId: 'workspace-docs',
      parentFolderId: 'folder-new',
      beforeNodeId: null,
    })
  })

  it('includes the active workspace when grouping selected workspaces', async () => {
    ctx.workspace = { id: 'workspace-tools', name: 'kaivo-app' }
    renderSidebar()

    fireEvent.click(await screen.findByText('docs-app'), { metaKey: true })
    fireEvent.keyDown(window, { key: 'g', metaKey: true })

    await waitFor(() => expect(createFolderMock).toHaveBeenCalledWith({ name: 'New folder', parentId: 'folder-cloud' }))
    expect(moveSidebarNodeMock).toHaveBeenCalledWith({
      nodeType: 'workspace',
      nodeId: 'workspace-tools',
      parentFolderId: 'folder-new',
      beforeNodeId: null,
    })
    expect(moveSidebarNodeMock).toHaveBeenCalledWith({
      nodeType: 'workspace',
      nodeId: 'workspace-docs',
      parentFolderId: 'folder-new',
      beforeNodeId: null,
    })
  })

  it('prevents browser default behavior on shift-click workspace links', async () => {
    renderSidebar()

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })
    const allowed = (await screen.findByText('docs-app')).dispatchEvent(event)

    expect(allowed).toBe(false)
  })
})
