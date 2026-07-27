import { describe, expect, it, vi } from 'vitest'
import { handleAgentUiOpenPaneEvent } from '../../src/lib/agent-ui-open-pane.js'
import { explicitChildSessionId } from '../../src/routes/env/agent/child-transcript-link.js'

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

describe('session-view child transcript linking', () => {
  it('links ordinary child transcripts only through explicit stable IDs', () => {
    expect(explicitChildSessionId({ type: 'tool', tool: 'task' })).toBeNull()
    expect(explicitChildSessionId({ type: 'tool', tool: 'task', metadata: { childSessionId: 'child-2' } })).toBe('child-2')
    expect(explicitChildSessionId({ type: 'tool', tool: 'task', state: { sessionID: 'child-1' } })).toBe('child-1')
  })
})
