import { describe, expect, it } from 'vitest'
import { browserTabIconForUrl, faviconOriginForUrl } from '../../src/lib/favicon-cache'

describe('favicon cache helpers', () => {
  it('normalizes browser tab origins and ignores internal URLs', () => {
    expect(faviconOriginForUrl('https://example.com/docs')).toBe('https://example.com')
    expect(faviconOriginForUrl('http://localhost:5173/path')).toBe('http://localhost:5173')
    expect(faviconOriginForUrl('about:blank')).toBeNull()
    expect(faviconOriginForUrl('not a url')).toBeNull()
  })

  it('selects distinct cached icons for tabs on the same origin', () => {
    const records = {
      'https://example.com': [{
        pageOrigin: 'https://example.com',
        iconUrl: 'https://example.com/favicon.ico',
        dataUrl: 'data:image/png;base64,aGk=',
        mediaType: 'image/png',
        sizeBytes: 2,
        updatedAt: new Date(),
        lastSeenAt: new Date(),
      }, {
        pageOrigin: 'https://example.com',
        iconUrl: 'https://example.com/status.ico',
        dataUrl: 'data:image/png;base64,c3RhdHVz',
        mediaType: 'image/png',
        sizeBytes: 6,
        updatedAt: new Date(),
        lastSeenAt: new Date(),
      }],
    }

    expect(browserTabIconForUrl({ url: 'https://example.com/a', records })).toEqual({
      kind: 'favicon',
      url: 'data:image/png;base64,aGk=',
      fallback: { kind: 'pane', pane: 'browser' },
    })
    expect(browserTabIconForUrl({ url: 'https://example.com/issues', faviconUrl: 'https://example.com/status.ico', records })).toEqual({
      kind: 'favicon',
      url: 'data:image/png;base64,c3RhdHVz',
      fallback: { kind: 'pane', pane: 'browser' },
    })
    expect(browserTabIconForUrl({ url: 'https://example.com/issues', faviconUrl: 'https://example.com/pending.ico', records })).toEqual({
      kind: 'favicon',
      url: 'https://example.com/pending.ico',
      fallback: { kind: 'pane', pane: 'browser' },
    })
    expect(browserTabIconForUrl({ url: 'https://other.example/a', records })).toEqual({ kind: 'pane', pane: 'browser' })
    expect(browserTabIconForUrl({ url: 'about:blank', records })).toEqual({ kind: 'pane', pane: 'browser' })
  })
})
