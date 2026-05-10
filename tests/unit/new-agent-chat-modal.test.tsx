// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceModeControl } from '../../src/routes/env/agent/new-agent-chat-modal'

afterEach(() => cleanup())

describe('WorkspaceModeControl', () => {
  it('renders an editable workspace name in new workspace mode', () => {
    const onWorkspaceNameChange = vi.fn()

    render(
      <WorkspaceModeControl
        mode="new"
        onModeChange={vi.fn()}
        existingWorkspaceName="zoottle"
        workspaceNameValue="sidebar-folders"
        onWorkspaceNameChange={onWorkspaceNameChange}
      />,
    )

    const input = screen.getByLabelText('Workspace name') as HTMLInputElement
    expect(input.value).toBe('sidebar-folders')
    fireEvent.change(input, { target: { value: 'Custom workspace' } })
    expect(onWorkspaceNameChange).toHaveBeenCalledWith('Custom workspace')
  })

  it('renders a static workspace name in existing workspace mode', () => {
    render(
      <WorkspaceModeControl
        mode="existing"
        onModeChange={vi.fn()}
        existingWorkspaceName="zoottle"
        workspaceNameValue="sidebar-folders"
        onWorkspaceNameChange={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText('Workspace name')).toBeNull()
    expect(screen.getByText('zoottle')).toBeTruthy()
  })

  it('emits mode changes from the New/Existing dropdown', () => {
    const onModeChange = vi.fn()

    render(
      <WorkspaceModeControl
        mode="existing"
        onModeChange={onModeChange}
        existingWorkspaceName="zoottle"
        workspaceNameValue="sidebar-folders"
        onWorkspaceNameChange={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Workspace mode'), { target: { value: 'new' } })
    expect(onModeChange).toHaveBeenCalledWith('new')
  })
})
