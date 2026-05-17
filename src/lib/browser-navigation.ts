import type { BookmarkRecord } from '../routes/workspace/bookmarks-store'

export type BrowserAddressDecision =
  | { kind: 'blank'; url: 'about:blank' }
  | { kind: 'url'; url: string }
  | { kind: 'search'; url: string; query: string }

export type BookmarkMatchReason = 'exact' | 'prefix' | 'substring'

export type BookmarkMatch = {
  bookmark: BookmarkRecord
  reason: BookmarkMatchReason
}

export function buildWebSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`
}

export function resolveBrowserAddress(raw: string): BrowserAddressDecision {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'blank', url: 'about:blank' }
  if (isLocalhost(trimmed) || isIpv4Host(trimmed)) return { kind: 'url', url: `http://${trimmed}` }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return { kind: 'url', url: trimmed }
  if (!/\s/.test(trimmed) && isDomainLike(trimmed)) return { kind: 'url', url: `https://${trimmed}` }
  return { kind: 'search', url: buildWebSearchUrl(trimmed), query: trimmed }
}

export function normalizeBrowserUrl(raw: string): string {
  return resolveBrowserAddress(raw).url
}

export function normalizeBookmarkUrl(raw: string): string {
  const decision = resolveBrowserAddress(raw)
  const value = decision.kind === 'search' ? raw.trim() : decision.url
  if (!value) return ''
  try {
    const url = new URL(value)
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    url.hash = ''
    const normalized = url.toString()
    return normalized.endsWith('/') && url.pathname === '/' && !url.search ? normalized.slice(0, -1) : normalized
  } catch {
    return value
  }
}

export function bookmarkOriginForUrl(raw: string): string | null {
  try {
    return new URL(normalizeBookmarkUrl(raw)).origin
  } catch {
    return null
  }
}

export function matchBookmarks(bookmarks: BookmarkRecord[], query: string): BookmarkMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return bookmarks
    .map((bookmark) => {
      const reason = bookmarkMatchReason(bookmark, q)
      return reason ? { bookmark, reason } : null
    })
    .filter((match): match is BookmarkMatch => match !== null)
    .sort((a, b) => {
      const score = bookmarkReasonScore(b.reason) - bookmarkReasonScore(a.reason)
      if (score !== 0) return score
      return bookmarkTime(b.bookmark) - bookmarkTime(a.bookmark)
    })
}

function bookmarkMatchReason(bookmark: BookmarkRecord, query: string): BookmarkMatchReason | null {
  const title = stringValue(bookmark.title).toLowerCase()
  const normalizedUrl = stringValue(bookmark.normalizedUrl).toLowerCase()
  const url = stringValue(bookmark.url).toLowerCase()
  const origin = stringValue(bookmark.origin).toLowerCase()
  if (!title || !url) return null
  if (title === query || normalizedUrl === query || url === query) return 'exact'
  if (title.startsWith(query) || origin.startsWith(query) || hostStartsWith(origin, query)) return 'prefix'
  if (title.includes(query) || normalizedUrl.includes(query) || url.includes(query) || origin.includes(query)) return 'substring'
  return null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function bookmarkTime(bookmark: BookmarkRecord): number {
  return bookmark.updatedAt instanceof Date ? bookmark.updatedAt.getTime() : 0
}

function bookmarkReasonScore(reason: BookmarkMatchReason): number {
  if (reason === 'exact') return 3
  if (reason === 'prefix') return 2
  return 1
}

function isLocalhost(value: string): boolean {
  return /^localhost(?::\d+)?(?:\/.*)?$/i.test(value)
}

function isIpv4Host(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/.*)?$/.test(value)
}

function isDomainLike(value: string): boolean {
  const host = value.split('/')[0] ?? ''
  return host.includes('.') && !host.startsWith('.') && !host.endsWith('.')
}

function hostStartsWith(origin: string, query: string): boolean {
  try {
    return new URL(origin).hostname.toLowerCase().startsWith(query)
  } catch {
    return false
  }
}
