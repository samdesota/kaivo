import { describe, expect, it } from 'vitest'
import { buildWebSearchUrl, matchBookmarks, normalizeBrowserUrl, resolveBrowserAddress, type BookmarkMatch } from '../../src/lib/browser-navigation'
import type { BookmarkRecord } from '../../src/routes/workspace/bookmarks-store'

function bookmark(input: Partial<BookmarkRecord> & { title: string; url?: string; updatedAt?: Date }): BookmarkRecord {
  return {
    id: input.id ?? input.title,
    title: input.title,
    url: input.url ?? `https://example.com/${input.title}`,
    normalizedUrl: input.normalizedUrl ?? input.url ?? `https://example.com/${input.title}`,
    origin: input.origin ?? 'https://example.com',
    faviconDataUrl: null,
    faviconUrl: null,
    createdAt: input.createdAt ?? new Date('2026-05-16T00:00:00Z'),
    updatedAt: input.updatedAt ?? new Date('2026-05-16T00:00:00Z'),
  }
}

function labels(matches: BookmarkMatch[]): string[] {
  return matches.map((match) => match.bookmark.title)
}

describe('browser navigation utilities', () => {
  it('normalizes domains, localhost, IPv4, schemes, whitespace searches, and empty input', () => {
    expect(resolveBrowserAddress('').kind).toBe('blank')
    expect(normalizeBrowserUrl('')).toBe('about:blank')
    expect(normalizeBrowserUrl('example.org/path')).toBe('https://example.org/path')
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeBrowserUrl('127.0.0.1:3000/docs')).toBe('http://127.0.0.1:3000/docs')
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
    expect(normalizeBrowserUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html')
    expect(resolveBrowserAddress('foo bar')).toEqual({
      kind: 'search',
      query: 'foo bar',
      url: 'https://www.google.com/search?q=foo%20bar',
    })
  })

  it('ranks exact bookmark title matches before prefix matches', () => {
    const matches = matchBookmarks([
      bookmark({ title: 'foozam', updatedAt: new Date('2026-05-16T02:00:00Z') }),
      bookmark({ title: 'foo', updatedAt: new Date('2026-05-16T01:00:00Z') }),
    ], 'foo')
    expect(labels(matches)).toEqual(['foo', 'foozam'])
    expect(matches.at(0)?.reason).toBe('exact')
    expect(matches.at(1)?.reason).toBe('prefix')
  })

  it('ranks exact normalized URL matches ahead of URL substring matches', () => {
    const exact = bookmark({ title: 'Exact', url: 'https://example.com/docs', normalizedUrl: 'https://example.com/docs', updatedAt: new Date('2026-05-16T01:00:00Z') })
    const substring = bookmark({ title: 'Substring', url: 'https://example.com/docs/more', normalizedUrl: 'https://example.com/docs/more', updatedAt: new Date('2026-05-16T02:00:00Z') })
    const matches = matchBookmarks([substring, exact], 'https://example.com/docs')
    expect(labels(matches)).toEqual(['Exact', 'Substring'])
    expect(matches.at(0)?.reason).toBe('exact')
  })

  it('encodes search URLs', () => {
    expect(buildWebSearchUrl('a b & c?')).toBe('https://www.google.com/search?q=a%20b%20%26%20c%3F')
  })

  it('ignores malformed bookmark records without throwing', () => {
    const malformed = { id: 'bad', title: null, url: null, normalizedUrl: null, origin: null, updatedAt: null } as unknown as BookmarkRecord
    expect(() => matchBookmarks([malformed, bookmark({ title: 'Docs', url: 'https://example.com/docs' })], 'doc')).not.toThrow()
    expect(labels(matchBookmarks([malformed, bookmark({ title: 'Docs', url: 'https://example.com/docs' })], 'doc'))).toEqual(['Docs'])
  })
})
