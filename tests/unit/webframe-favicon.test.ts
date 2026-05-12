import { describe, expect, it } from 'vitest'
// This exercises the adjacent webframe checkout when present; Vitest resolves it
// in the local monorepo, while this repo's TypeScript project does not own it.
// @ts-expect-error external sibling package source
import { selectFaviconCandidate } from '../../../webframe/src/favicon'

describe('webframe favicon candidate selection', () => {
  it('prefers valid same-origin larger candidates', () => {
    expect(selectFaviconCandidate({
      pageUrl: 'https://example.com/page',
      candidates: [
        'https://cdn.example.net/favicon-256.png',
        'https://example.com/favicon-16.png',
        'https://example.com/favicon-192.png',
      ],
    })).toBe('https://example.com/favicon-192.png')
  })

  it('keeps the previous favicon on empty or invalid events', () => {
    expect(selectFaviconCandidate({
      pageUrl: 'https://example.com/page',
      candidates: [],
      previous: 'https://example.com/favicon.ico',
    })).toBe('https://example.com/favicon.ico')

    expect(selectFaviconCandidate({
      pageUrl: 'https://example.com/page',
      candidates: ['about:blank', 'file:///tmp/favicon.png', ''],
      previous: 'https://example.com/favicon.ico',
    })).toBe('https://example.com/favicon.ico')
  })
})
