import { describe, expect, it } from 'vitest'
import { browserTabIconForUrl, faviconOriginForUrl } from '../../src/lib/favicon-cache'

describe('favicon cache helpers', () => {
  it('normalizes browser tab origins and ignores internal URLs', () => {
    expect(faviconOriginForUrl('https://example.com/docs')).toBe('https://example.com')
    expect(faviconOriginForUrl('http://localhost:5173/path')).toBe('http://localhost:5173')
    expect(faviconOriginForUrl('about:blank')).toBeNull()
    expect(faviconOriginForUrl('not a url')).toBeNull()
  })

  it('switches browser tab icons by origin and falls back for missing records', () => {
    const records = {
      'https://example.com': {
        pageOrigin: 'https://example.com',
        iconUrl: 'https://example.com/favicon.ico',
        dataUrl: 'data:image/png;base64,aGk=',
        mediaType: 'image/png',
        sizeBytes: 2,
        updatedAt: new Date(),
        lastSeenAt: new Date(),
      },
    }

    expect(browserTabIconForUrl({ url: 'https://example.com/a', records })).toEqual({
      kind: 'favicon',
      url: 'data:image/png;base64,aGk=',
      fallback: { kind: 'pane', pane: 'browser' },
    })
    expect(browserTabIconForUrl({ url: 'https://other.example/a', records })).toEqual({ kind: 'pane', pane: 'browser' })
    expect(browserTabIconForUrl({ url: 'about:blank', records })).toEqual({ kind: 'pane', pane: 'browser' })
  })
})
