// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceTabBar } from '../../src/routes/workspace/workspace-tab-bar'

const createdWorkspace = { id: 'workspace-new', name: 'Untitled workspace' }
const renameCalls: Array<{ id: string; name: string }> = []

vi.mock('../../src/trpc', () => ({
  trpc: {
    useUtils: () => ({ workspace: { list: { invalidate: vi.fn() } } }),
    workspace: {
      list: { useQuery: () => ({ data: [{ id: 'workspace-old', name: 'Old workspace' }] }) },
      create: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn(async () => createdWorkspace) }) },
      rename: {
        useMutation: () => ({
          mutateAsync: vi.fn(async (input: { id: string; name: string }) => {
            renameCalls.push(input)
            return { ...createdWorkspace, name: input.name }
          }),
        }),
      },
      archive: {
        useMutation: () => ({
          mutateAsync: vi.fn(async (input: { id: string }) => ({ ok: true, ...input })),
        }),
      },
    },
  },
}))

function renderBar() {
  const rootRoute = createRootRoute()
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$workspaceId',
    component: () => <WorkspaceTabBar activeWorkspaceId="workspace-old" activeWorkspaceName="Old workspace" />,
    validateSearch: () => ({ chat: undefined as string | undefined, tab: undefined as string | undefined }),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute]),
    history: createMemoryHistory({ initialEntries: ['/w/workspace-old'] }),
  })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  renameCalls.length = 0
  window.scrollTo = vi.fn()
})

afterEach(() => cleanup())

describe('WorkspaceTabBar', () => {
  it('clicking + creates a workspace and focuses the inline title input', async () => {
    renderBar()

    fireEvent.click(await screen.findByRole('button', { name: 'Create new workspace' }))

    const input = await screen.findByLabelText('Workspace name')
    expect(input).toBe(document.activeElement)
    expect((input as HTMLInputElement).value).toBe('Untitled workspace')
  })

  it('Enter saves rename and Escape cancels without deleting workspace tab', async () => {
    renderBar()

    fireEvent.doubleClick(await screen.findByText('Old workspace'))
    const input = await screen.findByLabelText('Workspace name')
    fireEvent.change(input, { target: { value: 'Renamed workspace' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameCalls).toEqual([{ id: 'workspace-old', name: 'Renamed workspace' }]))

    fireEvent.doubleClick(screen.getByText('Old workspace'))
    const cancelInput = await screen.findByLabelText('Workspace name')
    fireEvent.change(cancelInput, { target: { value: 'Cancelled name' } })
    fireEvent.keyDown(cancelInput, { key: 'Escape' })
    expect(screen.getByText('Old workspace')).toBeTruthy()
  })
})
