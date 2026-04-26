// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ShellChrome } from '../../src/routes/env/shell/shell-chrome'
import { SplitPane } from '../../src/routes/env/shell/split-pane'

describe('ShellChrome', () => {
  it('renders env header actions after extraction', () => {
    render(
      <ShellChrome
        title="Local Mac"
        subtitle="local · running"
        splitStorageKey="test.shellChrome.split"
        left={<div>Agents</div>}
        actions={
          <>
            <button>⌘K</button>
            <button>Shells</button>
            <button>Previews</button>
            <a href="/settings">Settings</a>
          </>
        }
      />,
    )

    expect(screen.getByText('Local Mac')).toBeTruthy()
    expect(screen.getByText('local · running')).toBeTruthy()
    expect(screen.getByRole('button', { name: '⌘K' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Shells' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Previews' })).toBeTruthy()
    expect(screen.getByText('Settings')).toBeTruthy()
  })
})

describe('SplitPane', () => {
  it('persists split ratio and resets on double-click', () => {
    const storageKey = 'test.split.ratio'
    localStorage.removeItem(storageKey)
    const { container } = render(
      <SplitPane
        storageKey={storageKey}
        initialRatio={0.7}
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    )
    const root = container.firstElementChild as HTMLElement
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 1000 }),
    })

    const handle = screen.getByRole('separator')
    fireEvent.mouseDown(handle, { clientX: 700 })
    fireEvent.mouseMove(window, { clientX: 500 })
    fireEvent.mouseUp(window)
    expect(localStorage.getItem(storageKey)).toBe('0.5')

    fireEvent.doubleClick(handle)
    expect(localStorage.getItem(storageKey)).toBe('0.7')
  })
})
