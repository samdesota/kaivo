import { describe, expect, it, vi } from 'vitest'
import { handleAgentUiOpenPaneEvent } from '../../src/lib/agent-ui-open-pane.js'

describe('session-view open_pane mapping', () => {
  it('maps browser open_pane events to right-pane actions', () => {
    const onOpenPane = vi.fn()
    handleAgentUiOpenPaneEvent(
      {
        type: 'open_pane',
        content: { type: 'browser', url: 'https://example.com' },
        title: 'Example',
        activate: true,
      },
      onOpenPane,
    )

    expect(onOpenPane).toHaveBeenCalledWith(
      { type: 'browser', url: 'https://example.com' },
      { title: 'Example', activate: true },
    )
  })
})
