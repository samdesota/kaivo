import { describe, expect, it, vi } from 'vitest'
import { handleAgentUiOpenPaneEvent } from '../../src/lib/agent-ui-open-pane'

describe('handleAgentUiOpenPaneEvent', () => {
  it('uses refresh hints instead of constructing a local tab when a refresh handler is available', () => {
    const onOpenPane = vi.fn()
    const onRefreshHint = vi.fn()

    handleAgentUiOpenPaneEvent(
      { type: 'open_pane', content: { type: 'file', path: '/tmp/a.ts' }, title: 'a.ts', activate: true },
      onOpenPane,
      onRefreshHint,
    )

    expect(onRefreshHint).toHaveBeenCalledOnce()
    expect(onOpenPane).not.toHaveBeenCalled()
  })

  it('keeps legacy local opening behavior when no refresh handler is available', () => {
    const onOpenPane = vi.fn()

    handleAgentUiOpenPaneEvent(
      { type: 'open_pane', content: { type: 'preview', port: 5173 }, title: 'preview', activate: false },
      onOpenPane,
    )

    expect(onOpenPane).toHaveBeenCalledWith({ type: 'preview', port: 5173 }, { title: 'preview', activate: false })
  })
})
