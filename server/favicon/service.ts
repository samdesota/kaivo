import { inArray } from 'drizzle-orm'
import { db, type Db } from '../db/client.js'
import { faviconCache, type FaviconCacheRow } from '../db/schema.js'

const MAX_FAVICON_BYTES = 128 * 1024
const SUPPORTED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

export type FaviconCacheInput = {
  pageOrigin: string
  iconUrl: string
  dataUrl: string
}

export class FaviconCacheError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export function normalizeFaviconPageOrigin(input: string): string | null {
  try {
    const url = new URL(input)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

export function validateFaviconCacheInput(input: FaviconCacheInput): Omit<FaviconCacheRow, 'updatedAt' | 'lastSeenAt'> {
  const pageOrigin = normalizeFaviconPageOrigin(input.pageOrigin)
  if (!pageOrigin) throw new FaviconCacheError('invalid page origin')
  validateIconUrl(input.iconUrl)
  const data = parseDataUrl(input.dataUrl)
  if (!SUPPORTED_MEDIA_TYPES.has(data.mediaType)) throw new FaviconCacheError('unsupported favicon media type')
  if (data.sizeBytes <= 0 || data.sizeBytes > MAX_FAVICON_BYTES) throw new FaviconCacheError('favicon data size out of bounds')
  return {
    pageOrigin,
    iconUrl: input.iconUrl,
    dataUrl: input.dataUrl,
    mediaType: data.mediaType,
    sizeBytes: data.sizeBytes,
  }
}

export function createFaviconService(database: Db = db) {
  return {
    async getByOrigins(origins: string[]): Promise<Record<string, FaviconCacheRow>> {
      const normalized = Array.from(new Set(origins.map(normalizeFaviconPageOrigin).filter((origin): origin is string => Boolean(origin))))
      if (normalized.length === 0) return {}
      const rows = await database.select().from(faviconCache).where(inArray(faviconCache.pageOrigin, normalized))
      return Object.fromEntries(rows.map((row) => [row.pageOrigin, row]))
    },

    async upsert(input: FaviconCacheInput): Promise<void> {
      const record = validateFaviconCacheInput(input)
      const now = new Date()
      await database
        .insert(faviconCache)
        .values({ ...record, updatedAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: faviconCache.pageOrigin,
          set: {
            iconUrl: record.iconUrl,
            dataUrl: record.dataUrl,
            mediaType: record.mediaType,
            sizeBytes: record.sizeBytes,
            updatedAt: now,
            lastSeenAt: now,
          },
        })
    },
  }
}

export const faviconService = createFaviconService()

function validateIconUrl(input: string): void {
  try {
    const url = new URL(input)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'data:') {
      throw new FaviconCacheError('invalid favicon URL')
    }
  } catch (err) {
    if (err instanceof FaviconCacheError) throw err
    throw new FaviconCacheError('invalid favicon URL')
  }
}

function parseDataUrl(input: string): { mediaType: string; sizeBytes: number } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(input)
  if (!match) throw new FaviconCacheError('invalid favicon data URL')
  const [, rawMediaType, rawBase64] = match
  if (!rawMediaType || !rawBase64) throw new FaviconCacheError('invalid favicon data URL')
  const mediaType = rawMediaType.toLowerCase()
  const sizeBytes = Buffer.byteLength(Buffer.from(rawBase64, 'base64'))
  return { mediaType, sizeBytes }
}
