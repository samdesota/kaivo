// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSidebarSubtaskRow } from '../../src/routes/workspace'

afterEach(() => cleanup())

describe('WorkspaceSidebarSubtaskRow', () => {
  it('renders durable task state and selects the independent task chat', () => {
    const onSelect = vi.fn()
    render(<WorkspaceSidebarSubtaskRow
      depth={2}
      active
      onSelect={onSelect}
      task={{
        id: 'task-1', dispatchSessionId: 'dispatch-1', sessionId: 'session-task-1', title: 'Implement parser', state: 'returned',
        running: false, pendingAttentionCount: 0, latestReturnSummary: 'Parser is ready for review', createdAt: '2026-07-21T00:00:00Z',
      }}
    />)

    const row = screen.getByRole('button', { name: 'Implement parser, Parser is ready for review' })
    expect(row.getAttribute('aria-current')).toBe('page')
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('shows provisioning tasks without making an unavailable chat selectable', () => {
    render(<WorkspaceSidebarSubtaskRow
      depth={1}
      active={false}
      onSelect={vi.fn()}
      task={{
        id: 'task-2', dispatchSessionId: 'dispatch-1', sessionId: null, title: 'Prepare docs', state: 'provisioning',
        running: false, pendingAttentionCount: 0, latestReturnSummary: null, createdAt: '2026-07-21T00:00:01Z',
      }}
    />)
    expect(screen.getByRole('button', { name: 'Prepare docs, preparing' }).hasAttribute('disabled')).toBe(true)
  })
})
