import { describe, expect, it } from 'vitest'
import { workspaceTabFromPaneContent } from '../../src/routes/workspace/open-pane'

describe('workspaceTabFromPaneContent', () => {
  it('creates preview tabs instead of dropping preview open requests', () => {
    expect(workspaceTabFromPaneContent({ type: 'preview', port: 5173 }, 'env-a')).toMatchObject({
      type: 'preview',
      envId: 'env-a',
      port: 5173,
      title: 'preview :5173',
    })
  })

  it('creates browser tabs without an env and preserves native tab ids when provided', () => {
    expect(workspaceTabFromPaneContent({ type: 'browser', url: 'http://127.0.0.1:5173', browserTabId: 'native-1' }, undefined)).toMatchObject({
      type: 'browser',
      url: 'http://127.0.0.1:5173',
      browserTabId: 'native-1',
      title: 'http://127.0.0.1:5173',
    })
  })

  it('rejects env-backed tabs when no env is available', () => {
    expect(workspaceTabFromPaneContent({ type: 'preview', port: 5173 }, undefined)).toBeNull()
    expect(workspaceTabFromPaneContent({ type: 'shell', shellId: 'shell-1' }, undefined)).toBeNull()
  })
})
