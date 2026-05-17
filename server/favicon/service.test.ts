import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { runLocalAppMigrations } from '../db/local-migrate'
import { createFaviconService, normalizeFaviconPageOrigin, validateFaviconCacheInput } from './service'
import { browserTabIconForUrl } from '../../src/lib/favicon-cache'

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgo='

function createTestDb() {
  const sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-favicon-cache-test-')), 'app.db')
  runLocalAppMigrations(sqlitePath)
  const sqlite = new Database(sqlitePath)
  return { sqlitePath, sqlite, db: drizzle(sqlite, { schema }) }
}

describe('favicon cache service', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizes origins and rejects invalid or oversized favicon data', () => {
    expect(normalizeFaviconPageOrigin('https://example.com/path?q=1')).toBe('https://example.com')
    expect(normalizeFaviconPageOrigin('about:blank')).toBeNull()
    expect(() => validateFaviconCacheInput({
      pageOrigin: 'https://example.com',
      iconUrl: 'https://example.com/favicon.ico',
      dataUrl: 'data:text/plain;base64,SGk=',
    })).toThrow('unsupported favicon media type')
    expect(() => validateFaviconCacheInput({
      pageOrigin: 'https://example.com',
      iconUrl: 'https://example.com/favicon.ico',
      dataUrl: `data:image/png;base64,${Buffer.alloc(129 * 1024).toString('base64')}`,
    })).toThrow('favicon data size out of bounds')
  })

  it('upserts and reads favicon records from migrated SQLite', async () => {
    const { sqlitePath, sqlite, db } = createTestDb()
    try {
      const service = createFaviconService(db)
      await service.upsert({
        pageOrigin: 'https://example.com/page',
        iconUrl: 'https://example.com/favicon.ico',
        dataUrl: PNG_1X1,
      })

      const rows = await service.getByOrigins(['https://example.com/other'])

      expect(rows['https://example.com']).toMatchObject({
        pageOrigin: 'https://example.com',
        iconUrl: 'https://example.com/favicon.ico',
        dataUrl: PNG_1X1,
        mediaType: 'image/png',
      })
      expect(browserTabIconForUrl({ url: 'https://example.com/restored', records: rows })).toEqual({
        kind: 'favicon',
        url: PNG_1X1,
        fallback: { kind: 'pane', pane: 'browser' },
      })
      expect(rows['https://example.com']!.sizeBytes).toBeGreaterThan(0)
      const readonly = new Database(sqlitePath, { readonly: true })
      try {
        expect(readonly.prepare('SELECT COUNT(*) AS count FROM favicon_cache').get()).toEqual({ count: 1 })
      } finally {
        readonly.close()
      }
    } finally {
      sqlite.close()
    }
  })

  it('fetches favicon bytes server-side and stores a data URL', async () => {
    const { sqlite, db } = createTestDb()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })))
    try {
      const service = createFaviconService(db)
      const row = await service.cacheFromUrl({
        pageOrigin: 'https://www.google.com/search?q=x',
        iconUrl: 'https://www.gstatic.com/images/branding/searchlogo/ico/favicon.ico',
      })

      expect(fetch).toHaveBeenCalledWith('https://www.gstatic.com/images/branding/searchlogo/ico/favicon.ico')
      expect(row).toMatchObject({
        pageOrigin: 'https://www.google.com',
        iconUrl: 'https://www.gstatic.com/images/branding/searchlogo/ico/favicon.ico',
        mediaType: 'image/png',
        sizeBytes: 4,
      })
      expect(row.dataUrl).toBe('data:image/png;base64,iVBORw==')
      const rows = await service.getByOrigins(['https://www.google.com/'])
      expect(rows['https://www.google.com']?.dataUrl).toBe(row.dataUrl)
    } finally {
      sqlite.close()
    }
  })
})
