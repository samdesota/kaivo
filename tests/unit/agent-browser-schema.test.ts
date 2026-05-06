import { describe, expect, it } from 'vitest'
import * as env from '../../packages/env-server/src/trpc/routers/agent-browser-schema.js'
import * as sandbox from '../../server/trpc/routers/agent-browser-schema.js'

const sessionInput = { opencodeSessionId: 'oc-session-1' }

describe('agent browser schemas', () => {
  it('accepts valid tool inputs on both server surfaces', () => {
    for (const contracts of [env, sandbox]) {
      expect(contracts.listTabsInputSchema.parse(sessionInput)).toEqual(sessionInput)
      expect(contracts.connectTabInputSchema.parse({ ...sessionInput, browserTabId: 'tab-1' })).toEqual({
        ...sessionInput,
        browserTabId: 'tab-1',
      })
      expect(contracts.openAndConnectInputSchema.parse({ ...sessionInput, url: 'localhost:5173' }).url).toBe(
        'http://localhost:5173',
      )
      expect(contracts.cdpConnectionInputSchema.parse({ ...sessionInput, cdpId: 'cdp-1' })).toEqual({
        ...sessionInput,
        cdpId: 'cdp-1',
      })
      expect(
        contracts.snapshotInputSchema.parse({ ...sessionInput, cdpId: 'cdp-1', filter: 'submit', viewportOnly: true }),
      ).toMatchObject({ cdpId: 'cdp-1', filter: 'submit', viewportOnly: true })
      expect(
        contracts.interactInputSchema.parse({
          ...sessionInput,
          cdpId: 'cdp-1',
          action: { type: 'click', elementId: 'e1' },
          postSnapshot: { wait: 'settle', waitMs: 100 },
        }),
      ).toMatchObject({ cdpId: 'cdp-1', action: { type: 'click', elementId: 'e1' } })
      expect(contracts.screenshotInputSchema.parse({ ...sessionInput, cdpId: 'cdp-1', quality: 55 })).toMatchObject({
        cdpId: 'cdp-1',
        quality: 55,
      })
      expect(
        contracts.executeJsInputSchema.parse({ ...sessionInput, cdpId: 'cdp-1', expression: 'document.title' }),
      ).toMatchObject({ cdpId: 'cdp-1', expression: 'document.title' })
      expect(contracts.readLogsInputSchema.parse({ ...sessionInput, cdpId: 'cdp-1', maxEntries: 25 })).toMatchObject({
        cdpId: 'cdp-1',
        maxEntries: 25,
      })
    }
  })

  it('rejects stale or unsafe tool inputs', () => {
    for (const contracts of [env, sandbox]) {
      expect(contracts.cdpConnectionInputSchema.safeParse({ ...sessionInput, cdpId: '' }).success).toBe(false)
      expect(contracts.connectTabInputSchema.safeParse({ ...sessionInput, browserTabId: '' }).success).toBe(false)
      expect(
        contracts.interactInputSchema.safeParse({ ...sessionInput, cdpId: 'cdp-1', action: { type: 'click', elementId: '' } })
          .success,
      ).toBe(false)
      expect(
        contracts.interactInputSchema.safeParse({ ...sessionInput, cdpId: 'cdp-1', action: { type: 'fill', fields: [] } })
          .success,
      ).toBe(false)
      expect(
        contracts.screenshotInputSchema.safeParse({ ...sessionInput, cdpId: 'cdp-1', quality: 101 }).success,
      ).toBe(false)
      expect(
        contracts.executeJsInputSchema.safeParse({ ...sessionInput, cdpId: 'cdp-1', expression: '' }).success,
      ).toBe(false)
      expect(
        contracts.readLogsInputSchema.safeParse({ ...sessionInput, cdpId: 'cdp-1', maxEntries: 0 }).success,
      ).toBe(false)
      expect(
        contracts.executeJsInputSchema.safeParse({
          ...sessionInput,
          cdpId: 'cdp-1',
          expression: '1'.repeat(contracts.MAX_JAVASCRIPT_EXPRESSION_LENGTH + 1),
        }).success,
      ).toBe(false)
    }
  })

  it('rejects unsafe browser URL policies', () => {
    for (const contracts of [env, sandbox]) {
      expect(contracts.safeBrowserUrlSchema.parse('example.com')).toBe('https://example.com')
      expect(contracts.safeBrowserUrlSchema.parse('about:blank')).toBe('about:blank')
      expect(contracts.safeBrowserUrlSchema.safeParse('file:///etc/passwd').success).toBe(false)
      expect(contracts.safeBrowserUrlSchema.safeParse('javascript:alert(1)').success).toBe(false)
      expect(contracts.safeBrowserUrlSchema.safeParse('slack://open').success).toBe(false)
      expect(
        contracts.interactInputSchema.safeParse({
          ...sessionInput,
          cdpId: 'cdp-1',
          action: { type: 'goto', url: 'file:///etc/passwd' },
        }).success,
      ).toBe(false)
    }
  })

  it('validates every interact action type and post-snapshot options', () => {
    const actions = [
      { type: 'click', elementId: 'e1' },
      { type: 'type', elementId: 'e1', text: 'hello', clear: true },
      { type: 'fill', fields: [{ elementId: 'e1', text: 'hello' }] },
      { type: 'scroll', x: 0, y: 200 },
      { type: 'goto', url: 'example.com' },
      { type: 'back' },
      { type: 'forward' },
      { type: 'wait', ms: 250, until: 'settle' },
    ]

    for (const contracts of [env, sandbox]) {
      for (const action of actions) {
        expect(
          contracts.interactInputSchema.safeParse({
            ...sessionInput,
            cdpId: 'cdp-1',
            action,
            postSnapshot: { wait: 'settle', waitMs: 100, filter: 'save' },
          }).success,
        ).toBe(true)
      }
      expect(
        contracts.interactInputSchema.safeParse({
          ...sessionInput,
          cdpId: 'cdp-1',
          action: { type: 'wait', ms: 10_000 },
        }).success,
      ).toBe(false)
    }
  })

  it('defines scoped browser error codes', () => {
    for (const contracts of [env, sandbox]) {
      expect(contracts.browserErrorCodeSchema.options).toEqual([
        'browser_tools_unavailable',
        'browser_tab_closed',
        'browser_connection_not_found',
        'element_id_not_found',
        'unsafe_url',
        'unsafe_javascript',
        'payload_too_large',
        'invalid_action',
      ])
    }
  })
})
