import { asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { bookmarks, type BookmarkRow } from '../db/schema.js'
import { db, type Db } from '../db/client.js'

export class BookmarkError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_bookmark',
    message: string,
  ) {
    super(message)
  }
}

export type BookmarkInput = {
  title: string
  url: string
  faviconDataUrl?: string | null
  faviconUrl?: string | null
}

export function normalizeBookmarkUrl(raw: string): string {
  const trimmed = raw.trim()
  try {
    const url = new URL(trimmed)
    url.hash = ''
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = ''
    url.hostname = url.hostname.toLowerCase()
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/$/, '')
  } catch {
    return trimmed
  }
}

export function bookmarkOriginForUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.origin
  } catch {
    return null
  }
}

export function createBookmarkService(database: Db = db) {
  async function list(): Promise<BookmarkRow[]> {
    return await database.select().from(bookmarks).orderBy(asc(bookmarks.updatedAt), asc(bookmarks.id))
  }

  async function upsert(input: BookmarkInput): Promise<BookmarkRow> {
    const title = input.title.trim()
    const url = input.url.trim()
    const normalizedUrl = normalizeBookmarkUrl(url)
    if (!title) throw new BookmarkError('invalid_bookmark', 'bookmark title is required')
    if (!url || !bookmarkOriginForUrl(normalizedUrl)) throw new BookmarkError('invalid_bookmark', 'bookmark URL is invalid')

    const now = new Date()
    const existing = await database
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.normalizedUrl, normalizedUrl))
      .limit(1)
    const current = existing[0] as BookmarkRow | undefined
    if (current) {
      const rows = await database
        .update(bookmarks)
        .set({
          title,
          url: normalizedUrl,
          origin: bookmarkOriginForUrl(normalizedUrl),
          faviconDataUrl: input.faviconDataUrl ?? null,
          faviconUrl: input.faviconUrl ?? null,
          updatedAt: now,
        })
        .where(eq(bookmarks.id, current.id))
        .returning()
      return (rows[0] as BookmarkRow | undefined) ?? { ...current, title, url: normalizedUrl, origin: bookmarkOriginForUrl(normalizedUrl), faviconDataUrl: input.faviconDataUrl ?? null, faviconUrl: input.faviconUrl ?? null, updatedAt: now }
    }

    const row: BookmarkRow = {
      id: ulid().toLowerCase(),
      title,
      url: normalizedUrl,
      normalizedUrl,
      origin: bookmarkOriginForUrl(normalizedUrl),
      faviconDataUrl: input.faviconDataUrl ?? null,
      faviconUrl: input.faviconUrl ?? null,
      createdAt: now,
      updatedAt: now,
    }
    await database.insert(bookmarks).values(row)
    return row
  }

  async function deleteBookmark(id: string): Promise<void> {
    await database.delete(bookmarks).where(eq(bookmarks.id, id))
  }

  return { list, upsert, delete: deleteBookmark }
}

export const bookmarkService = createBookmarkService()
