import { describe, expect, it } from 'vitest'
import { paneContentSchema as envPaneContentSchema } from '../../packages/env-server/src/trpc/routers/agent-ui-schema.js'
import { paneContentSchema as sandboxPaneContentSchema } from '../../server/trpc/routers/agent-ui-schema.js'

describe('agent UI browser pane schemas', () => {
  it('accept valid browser pane content', () => {
    expect(envPaneContentSchema.parse({ type: 'browser', url: 'https://example.com' })).toEqual({
      type: 'browser',
      url: 'https://example.com',
    })
    expect(
      sandboxPaneContentSchema.parse({
        type: 'browser',
        browserTabId: 'tab-1',
      }),
    ).toEqual({ type: 'browser', browserTabId: 'tab-1' })
  })

  it('rejects invalid browser pane content', () => {
    expect(envPaneContentSchema.safeParse({ type: 'browser', url: '' }).success).toBe(false)
    expect(
      sandboxPaneContentSchema.safeParse({ type: 'browser', browserTabId: 123 }).success,
    ).toBe(false)
  })
})
