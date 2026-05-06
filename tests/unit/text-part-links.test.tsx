// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextPart } from '../../src/routes/env/agent/parts/text-part'
import type { Part } from '../../src/routes/env/agent/transcript-store'

function textPart(text: string): Part {
  return {
    id: 'p1',
    type: 'text',
    messageID: 'm1',
    text,
    time: { end: 1 },
  } as Part
}

describe('TextPart links', () => {
  afterEach(() => cleanup())

  it('opens assistant markdown links in a browser pane on plain click', () => {
    const onOpenBrowserPane = vi.fn()
    const view = render(
      <TextPart
        part={textPart('[Docs](https://example.com/docs)')}
        role="assistant"
        onOpenBrowserPane={onOpenBrowserPane}
      />,
    )

    fireEvent.click(view.getByRole('link', { name: 'Docs' }))

    expect(onOpenBrowserPane).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('leaves modifier-clicks to the browser', () => {
    const onOpenBrowserPane = vi.fn()
    const view = render(
      <TextPart
        part={textPart('[Docs](https://example.com/docs)')}
        role="assistant"
        onOpenBrowserPane={onOpenBrowserPane}
      />,
    )

    fireEvent.click(view.getByRole('link', { name: 'Docs' }), { metaKey: true })

    expect(onOpenBrowserPane).not.toHaveBeenCalled()
  })
})
