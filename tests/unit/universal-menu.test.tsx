// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { UniversalMenu } from '../../src/routes/env/universal-menu/universal-menu'

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; workingDir: string | null }>,
  browse: {
    data: {
      path: '/Users/sam',
      home: '/Users/sam',
      defaultPath: '/Users/sam/d/cloud-code-tools',
      parent: '/Users',
      dirs: [
        { name: 'cloud-code-tools', path: '/Users/sam/d/cloud-code-tools' },
        { name: 'scratch', path: '/Users/sam/scratch' },
      ],
      files: [
        { name: 'notes.md', path: '/Users/sam/notes.md' },
      ],
    },
    isLoading: false,
    error: null,
  },
  browseInputs: [] as Array<{ path?: string }>,
  startChat: vi.fn(async () => ({ id: 'session-new' })),
  createShell: vi.fn(async () => ({ id: 'shell-new' })),
  createDirectory: vi.fn(async ({ parentPath, name }: { parentPath: string; name: string }) => ({ name, path: `${parentPath}/${name}` })),
  invalidateBrowseHome: vi.fn(async () => undefined),
  cloneConfig: vi.fn(async () => ({ repoId: 'repo-new', workingDir: '/Users/sam/d/standalone/new-tree' })),
  createWorkspace: vi.fn(async () => ({ id: 'workspace-new' })),
  upsertWorkspaceResource: vi.fn(async () => ({ ok: true })),
  recentFolders: [] as Array<{ path: string; label: string | null }>,
  repoConfigs: [] as Array<{ id: string; name: string; originUrl?: string | null; githubFullName?: string | null }>,
  worktrees: [] as Array<{ id: string; name: string; slug: string; worktreeName: string; worktreeSlug: string; workingDir: string; githubFullName: string | null }>,
  shells: [] as Array<{ id: string; cwd: string; title: string | null; alive?: boolean }>,
  gitFiles: [] as Array<{ root: string; path: string; relativePath: string }>,
  workspaceTree: [] as Array<unknown>,
}))

vi.mock('../../src/env-trpc', () => ({
  envTrpc: {
    useUtils: () => ({ fs: { browseHome: { invalidate: mocks.invalidateBrowseHome } } }),
    agent: {
      sessionList: {
        useQuery: () => ({ data: mocks.sessions, isLoading: false }),
      },
      sessionStart: {
        useMutation: () => ({ mutateAsync: mocks.startChat, isPending: false }),
      },
    },
    fs: {
      browseHome: {
        useQuery: (input: { path?: string }) => {
          mocks.browseInputs.push(input)
          return mocks.browse
        },
      },
      searchGitTrackedFiles: {
        useQuery: () => ({ data: mocks.gitFiles, isLoading: false, error: null }),
      },
      createDirectory: {
        useMutation: () => ({ mutateAsync: mocks.createDirectory, isPending: false }),
      },
    },
    repo: {
      listRecentFolders: {
        useQuery: () => ({ data: mocks.recentFolders, isLoading: false, error: null }),
      },
      listWorktrees: {
        useQuery: () => ({ data: mocks.worktrees, isLoading: false, error: null }),
      },
      listConfigs: {
        useQuery: () => ({ data: mocks.repoConfigs, isLoading: false, error: null }),
      },
      cloneConfig: {
        useMutation: () => ({ mutateAsync: mocks.cloneConfig, isPending: false }),
      },
    },
    shell: {
      list: {
        useQuery: () => ({ data: mocks.shells, isLoading: false, error: null }),
      },
      create: {
        useMutation: () => ({ mutateAsync: mocks.createShell, isPending: false }),
      },
    },
  },
}))

vi.mock('../../src/trpc', () => ({
  trpc: {
    favicon: {
      getByOrigins: {
        useQuery: () => ({ data: {}, isLoading: false }),
      },
    },
    workspace: {
      listTree: {
        useQuery: () => ({ data: mocks.workspaceTree, isLoading: false, error: null }),
      },
      create: {
        useMutation: () => ({ mutateAsync: mocks.createWorkspace, isPending: false }),
      },
      upsertResource: {
        useMutation: () => ({ mutateAsync: mocks.upsertWorkspaceResource, isPending: false }),
      },
    },
  },
}))

afterEach(() => cleanup())

beforeEach(() => {
  mocks.sessions = []
  mocks.browse = {
    data: {
      path: '/Users/sam',
      home: '/Users/sam',
      defaultPath: '/Users/sam/d/cloud-code-tools',
      parent: '/Users',
      dirs: [
        { name: 'cloud-code-tools', path: '/Users/sam/d/cloud-code-tools' },
        { name: 'scratch', path: '/Users/sam/scratch' },
      ],
      files: [
        { name: 'notes.md', path: '/Users/sam/notes.md' },
      ],
    },
    isLoading: false,
    error: null,
  }
  mocks.browseInputs = []
  mocks.startChat.mockClear()
  mocks.createShell.mockClear()
  mocks.createDirectory.mockClear()
  mocks.invalidateBrowseHome.mockClear()
  mocks.cloneConfig.mockClear()
  mocks.createWorkspace.mockClear()
  mocks.upsertWorkspaceResource.mockClear()
  mocks.recentFolders = []
  mocks.repoConfigs = []
  mocks.worktrees = []
  mocks.shells = []
  mocks.gitFiles = []
  mocks.workspaceTree = []
  Object.defineProperty(window, 'focus', { value: vi.fn(), configurable: true })
})

describe('UniversalMenu baseline shell', () => {
  it('renders in the overlay shell and closes with Escape', () => {
    const onClose = vi.fn()
    render(
      <UniversalMenu
        open
        workspaceName="Workspace A"
        hasActiveTab={false}
        onClose={onClose}
        onCloseTab={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByText('New Tab')).toBeNull()
    expect(screen.queryByText('Workspace A')).toBeNull()

    fireEvent.keyDown(screen.getByLabelText('Universal menu search'), { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('searches command and scope rows without entering content search', () => {
    render(
      <UniversalMenu
        open
        workspaceName="Workspace A"
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
        onToggleSidebar={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: 'side' } })

    expect(screen.getByText('Collapse sidebar')).toBeTruthy()
    expect(screen.queryByText('Shells')).toBeNull()
  })

  it('navigates rows with the keyboard and runs the active command', () => {
    const onToggleSidebar = vi.fn()
    render(
      <UniversalMenu
        open
        workspaceName="Workspace A"
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
        onToggleSidebar={onToggleSidebar}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: 'side' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onToggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('creates a new shell from command search', async () => {
    const onOpenContent = vi.fn()
    mocks.sessions = [{ id: 'session-1', workingDir: '/Users/sam/d/foo' }]
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        activeSessionId="session-1"
        hasActiveTab={false}
        onOpenContent={onOpenContent}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: 'new shell' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onOpenContent).toHaveBeenCalledWith({ type: 'shell', shellId: 'shell-new' }))
    expect(mocks.createShell).toHaveBeenCalledWith({ workspaceId: 'workspace-1', cwd: '/Users/sam/d/foo' })
  })

  it('enters a scoped result list from a quick key and backs out with Escape', () => {
    render(
      <UniversalMenu
        open
        workspaceName="Workspace A"
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '#main' } })

    expect(screen.getByText('Work Trees')).toBeTruthy()
    expect(screen.getByText('No matching work trees or repo configs.')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('main')

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.getByText('File System')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('shows the active scope inside the input and exits on empty Backspace', () => {
    render(
      <UniversalMenu
        open
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '@' } })

    expect(screen.getByText('Web')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('')

    fireEvent.keyDown(input, { key: 'Backspace' })

    expect(screen.getByText('File System')).toBeTruthy()
  })

  it('shows the workspace open-state view until typing begins', () => {
    render(
      <UniversalMenu
        open
        workspaceName="Workspace A"
        hasActiveTab
        contextItems={[
          { id: 'shell-1', kind: 'shell', label: 'dev server', detail: '/Users/sam/repo', content: { type: 'shell', shellId: 'shell-1' } },
          { id: 'browser-1', kind: 'browser-tab', label: 'Local app', detail: 'http://127.0.0.1', content: { type: 'browser', url: 'http://127.0.0.1' } },
        ]}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    expect(screen.getAllByText('Shells').length).toBeGreaterThan(0)
    expect(screen.getByText('Pages')).toBeTruthy()
    expect(screen.getByText('dev server')).toBeTruthy()
    expect(screen.getByText('repo')).toBeTruthy()
    expect(screen.getByText('Local app')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Universal menu search'), { target: { value: 'settings' } })

    expect(screen.queryByText('Shells')).toBeNull()
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('selects contextual shell and browser rows', () => {
    const onOpenContent = vi.fn()
    render(
      <UniversalMenu
        open
        hasActiveTab
        contextItems={[
          { id: 'shell-1', kind: 'shell', label: 'dev server', detail: '/repo', content: { type: 'shell', shellId: 'shell-1' } },
          { id: 'browser-1', kind: 'browser-tab', label: 'Local app', detail: 'http://127.0.0.1', content: { type: 'browser', url: 'http://127.0.0.1' } },
        ]}
        onOpenContent={onOpenContent}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('dev server'))
    fireEvent.click(screen.getByText('Local app'))

    expect(onOpenContent).toHaveBeenCalledWith({ type: 'shell', shellId: 'shell-1' })
    expect(onOpenContent).toHaveBeenCalledWith({ type: 'browser', url: 'http://127.0.0.1' })
  })

  it('shows live workspace shells without open tabs on the landing page', () => {
    const onOpenContent = vi.fn()
    mocks.shells = [
      { id: 'shell-live', cwd: '/Users/sam/live', title: 'detached shell', alive: true },
      { id: 'shell-dead', cwd: '/Users/sam/dead', title: 'terminated shell', alive: false },
    ]
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onOpenContent={onOpenContent}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    expect(screen.getByText('detached shell')).toBeTruthy()
    expect(screen.queryByText('terminated shell')).toBeNull()

    fireEvent.click(screen.getByText('detached shell'))

    expect(onOpenContent).toHaveBeenCalledWith({ type: 'shell', shellId: 'shell-live' })
  })

  it('navigates contextual landing rows with the keyboard', async () => {
    const onOpenContent = vi.fn()
    render(
      <UniversalMenu
        open
        hasActiveTab
        contextItems={[
          { id: 'shell-1', kind: 'shell', label: 'dev server', detail: '/Users/sam/repo', content: { type: 'shell', shellId: 'shell-1' } },
          { id: 'browser-1', kind: 'browser-tab', label: 'Local app', detail: 'http://127.0.0.1', content: { type: 'browser', url: 'http://127.0.0.1' } },
        ]}
        onOpenContent={onOpenContent}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByText('Local app').closest('button')?.className).toContain('bg-highlight'))
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(onOpenContent).toHaveBeenCalledWith({ type: 'browser', url: 'http://127.0.0.1' })
  })

  it('searches recent folders and starts a chat', () => {
    mocks.recentFolders = [{ path: '/Users/sam/d/foo', label: 'foo' }]
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onClose={vi.fn()} onCloseTab={vi.fn()} />)

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: ':foo' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.startChat).toHaveBeenCalledWith({ workspaceId: 'workspace-1', directory: '/Users/sam/d/foo' })
  })

  it('shows filtered worktree hierarchy and starts a chat', () => {
    mocks.worktrees = [{ id: 'wt-1', name: 'baz', slug: 'baz', worktreeName: 'foo', worktreeSlug: 'foo', workingDir: '/Users/sam/d/baz/foo', githubFullName: 'sam/baz' }]
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onClose={vi.fn()} onCloseTab={vi.fn()} />)

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '#foo' } })

    expect(screen.getByText('sam/baz')).toBeTruthy()
    expect(screen.getAllByText('foo').length).toBeGreaterThan(0)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.startChat).toHaveBeenCalledWith({ workspaceId: 'workspace-1', directory: '/Users/sam/d/baz/foo' })
  })

  it('shows repo configs as clone rows and opens the create flow', () => {
    const onClose = vi.fn()
    mocks.repoConfigs = [{ id: 'config-1', name: 'standalone', githubFullName: 'sam/standalone' }]
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onClose={onClose} onCloseTab={vi.fn()} />)

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '#standalone' } })
    expect(screen.getByText('Clone repo')).toBeTruthy()
    fireEvent.click(screen.getByText('sam/standalone'))

    expect(screen.getByText('sam/standalone')).toBeTruthy()
    expect(screen.getAllByText('Create chat').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Workspace name')).toBeTruthy()
    expect(screen.getByPlaceholderText('bug-shell-resize')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shift-enter on a worktree opens the new workspace chat flow', () => {
    const onClose = vi.fn()
    mocks.worktrees = [{ id: 'wt-1', name: 'baz', slug: 'baz', worktreeName: 'foo', worktreeSlug: 'foo', workingDir: '/Users/sam/d/baz/foo', githubFullName: 'sam/baz' }]
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onClose={onClose} onCloseTab={vi.fn()} />)

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '#foo' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(screen.getAllByText('Create chat').length).toBeGreaterThan(0)
    expect(screen.getByDisplayValue('foo')).toBeTruthy()
    expect(mocks.startChat).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shift-click on a folder opens the new workspace chat flow', () => {
    const onClose = vi.fn()
    mocks.recentFolders = [{ path: '/Users/sam/d/foo', label: 'foo' }]
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onClose={onClose} onCloseTab={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Universal menu search'), { target: { value: ':foo' } })
    fireEvent.click(screen.getAllByText('foo')[0], { shiftKey: true })

    expect(screen.getAllByText('Create chat').length).toBeGreaterThan(0)
    expect(screen.getByDisplayValue('foo')).toBeTruthy()
    expect(mocks.startChat).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('defaults new workspace parent folder to the current workspace parent', () => {
    mocks.recentFolders = [{ path: '/Users/sam/d/foo', label: 'foo' }]
    mocks.workspaceTree = [{ type: 'folder', folder: { id: 'parent-1', name: 'Active Projects' }, children: [] }]
    render(<UniversalMenu open workspaceId="workspace-1" workspaceFolderId="parent-1" hasActiveTab={false} onClose={vi.fn()} onCloseTab={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Universal menu search'), { target: { value: ':foo' } })
    fireEvent.click(screen.getAllByText('foo')[0], { shiftKey: true })

    expect(screen.getByLabelText('Parent folder').textContent).toContain('Active Projects')
  })

  it('filters shells and focuses the selected shell', () => {
    const onOpenContent = vi.fn()
    mocks.shells = [{ id: 'shell-1', cwd: '/Users/sam/d/foo', title: 'foo server' }]
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onOpenContent={onOpenContent} onClose={vi.fn()} onCloseTab={vi.fn()} />)

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '$foo' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onOpenContent).toHaveBeenCalledWith({ type: 'shell', shellId: 'shell-1' })
  })

  it('filters web pages and focuses the selected page', () => {
    const onOpenContent = vi.fn()
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        contextItems={[{ id: 'browser-1', kind: 'browser-tab', label: 'Foo docs', detail: 'https://example.com/foo', content: { type: 'browser', url: 'https://example.com/foo' } }]}
        onOpenContent={onOpenContent}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '@foo' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onOpenContent).toHaveBeenCalledWith({ type: 'browser', url: 'https://example.com/foo' })
  })

  it('opens direct web URLs from the web scope', () => {
    const onOpenContent = vi.fn()
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onOpenContent={onOpenContent}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '@google.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onOpenContent).toHaveBeenCalledWith({ type: 'browser', url: 'https://google.com' })
  })

  it('opens direct web URLs from command search', () => {
    const onOpenContent = vi.fn()
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onOpenContent={onOpenContent}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: 'google.com' } })

    expect(screen.getByText('https://google.com')).toBeTruthy()
    expect(screen.getByText('open URL')).toBeTruthy()

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onOpenContent).toHaveBeenCalledWith({ type: 'browser', url: 'https://google.com' })
  })

  it('shows filtered workspace ancestry and switches workspace', () => {
    const onSwitchWorkspace = vi.fn()
    mocks.workspaceTree = [{ type: 'folder', folder: { id: 'baz', name: 'baz' }, children: [{ type: 'folder', folder: { id: 'bar', name: 'bar' }, children: [{ type: 'workspace', workspace: { id: 'foo-id', name: 'foo', folderId: 'bar' } }] }] }]
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onSwitchWorkspace={onSwitchWorkspace} onClose={vi.fn()} onCloseTab={vi.fn()} />)

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '>foo' } })

    expect(screen.getByText('baz')).toBeTruthy()
    expect(screen.getByText('bar')).toBeTruthy()
    expect(screen.getByText('foo')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSwitchWorkspace).toHaveBeenCalledWith('foo-id')
  })

  it('searches git files across open chat folders and opens a file', () => {
    const onOpenContent = vi.fn()
    mocks.sessions = [{ id: 'session-1', workingDir: '/Users/sam/d/foo' }]
    mocks.gitFiles = [{ root: '/Users/sam/d/foo', relativePath: 'src/foo.ts', path: '/Users/sam/d/foo/src/foo.ts' }]
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onOpenContent={onOpenContent} onClose={vi.fn()} onCloseTab={vi.fn()} />)

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '.foo' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onOpenContent).toHaveBeenCalledWith({ type: 'file', path: '/Users/sam/d/foo/src/foo.ts', absolute: true })
  })

  it('middle-truncates long find file paths', () => {
    mocks.sessions = [{ id: 'session-1', workingDir: '/Users/sam/d/foo' }]
    mocks.gitFiles = [{ root: '/Users/sam/d/foo', relativePath: 'docs/blah/alpha/beta/foo/bar.ts', path: '/Users/sam/d/foo/docs/blah/alpha/beta/foo/bar.ts' }]
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onClose={vi.fn()} onCloseTab={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Universal menu search'), { target: { value: '.bar' } })

    const rows = Array.from(screen.getByTestId('universal-menu-results').querySelectorAll('button')).map((button) => button.textContent ?? '')
    expect(rows.some((text) => text.includes('docs/blah/.../foo/bar.ts'))).toBe(true)
    expect(rows.some((text) => text.includes('docs/blah/alpha/beta/foo/bar.ts'))).toBe(false)
  })

  it('hides empty contextual sections', () => {
    render(
      <UniversalMenu
        open
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    expect(screen.queryByText('Recent workspace folders')).toBeNull()
    expect(screen.queryByText('Pages')).toBeNull()
  })

  it('starts a new chat when selecting an open workspace folder', () => {
    const onCreatedChat = vi.fn()
    const onClose = vi.fn()
    mocks.sessions = [{ id: 'session-1', workingDir: '/Users/sam/project' }]

    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onClose={onClose}
        onCloseTab={vi.fn()}
        onCreatedChat={onCreatedChat}
      />,
    )

    fireEvent.click(screen.getAllByText('project')[0]!)

    expect(mocks.startChat).toHaveBeenCalledWith({ workspaceId: 'workspace-1', directory: '/Users/sam/project' })
  })

  it('enters File System with slash and starts a chat from a browsed folder', async () => {
    const onCreatedChat = vi.fn()
    const onClose = vi.fn()
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onClose={onClose}
        onCloseTab={vi.fn()}
        onCreatedChat={onCreatedChat}
      />,
    )

    fireEvent.change(screen.getByLabelText('Universal menu search'), { target: { value: '/' } })
    expect(screen.getByText('File System')).toBeTruthy()
    expect(screen.getByText('sam')).toBeTruthy()
    expect(screen.getByText('cloud-code-tools')).toBeTruthy()

    fireEvent.click(screen.getByText('scratch'))

    await waitFor(() => expect(mocks.startChat).toHaveBeenCalledWith({ workspaceId: 'workspace-1', directory: '/Users/sam/scratch' }))
    expect(onCreatedChat).toHaveBeenCalledWith('session-new', 'workspace-1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens files from the File System scope', () => {
    const onOpenContent = vi.fn()
    const onClose = vi.fn()
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onClose={onClose}
        onCloseTab={vi.fn()}
        onOpenContent={onOpenContent}
      />,
    )

    fireEvent.change(screen.getByLabelText('Universal menu search'), { target: { value: '/notes' } })
    fireEvent.click(screen.getByText('notes.md'))

    expect(onOpenContent).toHaveBeenCalledWith({ type: 'file', path: '/Users/sam/notes.md', absolute: true })
    return waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('drills into a folder from the caret without creating a chat', () => {
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search') as HTMLInputElement
    fireEvent.change(input, { target: { value: '/' } })
    fireEvent.click(screen.getByLabelText('Open scratch'))

    expect(input.value).toBe('/Users/sam/scratch/')
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it('shows create folder as the last path result when the final segment is not an exact folder match', () => {
    mocks.browse = {
      ...mocks.browse,
      data: {
        path: '/Users/sam/foo',
        home: '/Users/sam',
        defaultPath: '/Users/sam/d/cloud-code-tools',
        parent: '/Users/sam',
        dirs: [{ name: 'bazooka', path: '/Users/sam/foo/bazooka' }],
        files: [{ name: 'baz.txt', path: '/Users/sam/foo/baz.txt' }],
      },
    }
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onClose={vi.fn()} onCloseTab={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Universal menu search'), { target: { value: 'foo/baz' } })

    const rows = Array.from(screen.getByTestId('universal-menu-results').querySelectorAll('button')).map((button) => button.textContent ?? '')
    expect(rows.some((text) => text.includes('bazooka'))).toBe(true)
    expect(rows.some((text) => text.includes('baz.txt'))).toBe(true)
    expect(rows[rows.length - 1]).toContain('New folder: baz')
  })

  it('creates a folder from the path create option without starting a chat or closing', async () => {
    const onClose = vi.fn()
    mocks.browse = {
      ...mocks.browse,
      data: {
        path: '/Users/sam/foo',
        home: '/Users/sam',
        defaultPath: '/Users/sam/d/cloud-code-tools',
        parent: '/Users/sam',
        dirs: [],
        files: [],
      },
    }
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onClose={onClose} onCloseTab={vi.fn()} />)

    const input = screen.getByLabelText('Universal menu search') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo/baz' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mocks.createDirectory).toHaveBeenCalledWith({ parentPath: '/Users/sam/foo', name: 'baz' }))
    await waitFor(() => expect(input.value).toBe('foo/baz/'))
    expect(mocks.startChat).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not show create folder when the path segment exactly matches a folder', () => {
    mocks.browse = {
      ...mocks.browse,
      data: {
        path: '/Users/sam/foo',
        home: '/Users/sam',
        defaultPath: '/Users/sam/d/cloud-code-tools',
        parent: '/Users/sam',
        dirs: [{ name: 'baz', path: '/Users/sam/foo/baz' }],
        files: [],
      },
    }
    render(<UniversalMenu open workspaceId="workspace-1" hasActiveTab={false} onClose={vi.fn()} onCloseTab={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Universal menu search'), { target: { value: 'foo/baz' } })

    expect(screen.queryByText('New folder: baz')).toBeNull()
  })

  it('treats path-like command input as File System path input', () => {
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: 'repos/' } })

    expect(screen.getByText('File System')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('repos/')
    expect(mocks.browseInputs.some((entry) => entry.path === '/Users/sam/repos/')).toBe(true)
  })

  it('uses bash-like anchors for absolute and home folder input', () => {
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: '~' } })
    expect(mocks.browseInputs.some((entry) => entry.path === '/Users/sam')).toBe(true)

    mocks.browseInputs = []
    fireEvent.change(input, { target: { value: '/' } })
    expect(mocks.browseInputs.some((entry) => entry.path === '/')).toBe(true)
  })

  it('selects current folder for slash paths and first child match for filtered paths', () => {
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: 'd/' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.startChat).toHaveBeenLastCalledWith({ workspaceId: 'workspace-1', directory: '/Users/sam' })

    fireEvent.change(input, { target: { value: 'd/clo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.startChat).toHaveBeenLastCalledWith({ workspaceId: 'workspace-1', directory: '/Users/sam/d/cloud-code-tools' })
  })

  it('does not let stationary mouse hover override the active row', () => {
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search')
    fireEvent.change(input, { target: { value: 'd/clo' } })
    fireEvent.mouseEnter(screen.getByText('sam'))
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.startChat).toHaveBeenLastCalledWith({ workspaceId: 'workspace-1', directory: '/Users/sam/d/cloud-code-tools' })
  })

  it('preserves typed path style when drilling with left or right arrows', () => {
    render(
      <UniversalMenu
        open
        workspaceId="workspace-1"
        hasActiveTab={false}
        onClose={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    )

    const input = screen.getByLabelText('Universal menu search') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'd/clo' } })
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(input.value).toBe('d/cloud-code-tools/')
    fireEvent.keyDown(input, { key: 'ArrowLeft' })
    expect(input.value).toBe('d/')
  })
})
