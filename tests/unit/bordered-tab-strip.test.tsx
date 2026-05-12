// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BorderedTabStrip } from '../../src/components/bordered-tab-strip'

describe('BorderedTabStrip', () => {
  it('renders an icon and preserves label, select, and close behavior', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()

    render(
      <BorderedTabStrip
        items={[{ id: 'tab-1', label: 'Terminal', icon: { kind: 'pane', pane: 'shell' } }]}
        activeId="tab-1"
        onSelect={onSelect}
        onClose={onClose}
      />,
    )

    expect(screen.getByText('Terminal')).toBeTruthy()
    expect(document.querySelector('svg[aria-hidden="true"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(onSelect).toHaveBeenCalledWith('tab-1')

    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(onClose).toHaveBeenCalledWith('tab-1')
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
