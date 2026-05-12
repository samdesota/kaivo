import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

type SelectFaviconCandidate = (input: {
  pageUrl: string
  candidates: string[]
  previous?: string
}) => string | undefined

const webframeFaviconPath = new URL('../../../webframe/src/favicon.ts', import.meta.url)
const describeIfWebframePresent = fs.existsSync(webframeFaviconPath) ? describe : describe.skip

describeIfWebframePresent('webframe favicon candidate selection', () => {
  async function loadSelectFaviconCandidate(): Promise<SelectFaviconCandidate> {
    const mod = await import(pathToFileURL(webframeFaviconPath.pathname).href)
    return (mod as { selectFaviconCandidate: SelectFaviconCandidate }).selectFaviconCandidate
  }

  it('prefers valid same-origin larger candidates', () => {
    return loadSelectFaviconCandidate().then((selectFaviconCandidate) => {
    expect(selectFaviconCandidate({
      pageUrl: 'https://example.com/page',
      candidates: [
        'https://cdn.example.net/favicon-256.png',
        'https://example.com/favicon-16.png',
        'https://example.com/favicon-192.png',
      ],
    })).toBe('https://example.com/favicon-192.png')
    })
  })

  it('keeps the previous favicon on empty or invalid events', () => {
    return loadSelectFaviconCandidate().then((selectFaviconCandidate) => {
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
})
