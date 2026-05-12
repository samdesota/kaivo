import type { TabIcon } from '../components/tab-icon'

export type FaviconCacheRecord = {
  pageOrigin: string
  iconUrl: string
  dataUrl: string
  mediaType: string
  sizeBytes: number
  updatedAt: Date
  lastSeenAt: Date
}

export function faviconOriginForUrl(input: string | undefined): string | null {
  if (!input) return null
  try {
    const url = new URL(input)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

export function browserTabIconForUrl(input: {
  url: string | undefined
  records: Record<string, FaviconCacheRecord | undefined>
  liveDataUrls?: Record<string, string | undefined>
}): TabIcon {
  const origin = faviconOriginForUrl(input.url)
  const liveUrl = origin ? input.liveDataUrls?.[origin] : undefined
  const cachedUrl = origin ? input.records[origin]?.dataUrl : undefined
  return liveUrl || cachedUrl
    ? { kind: 'favicon', url: liveUrl ?? cachedUrl!, fallback: { kind: 'pane', pane: 'browser' } }
    : { kind: 'pane', pane: 'browser' }
}

export async function fetchFaviconDataUrl(iconUrl: string, maxBytes = 128 * 1024): Promise<{ dataUrl: string; mediaType: string; sizeBytes: number }> {
  const response = await fetch(iconUrl)
  if (!response.ok) throw new Error(`favicon fetch failed: ${response.status}`)
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream'
  const blob = await response.blob()
  if (blob.size <= 0 || blob.size > maxBytes) throw new Error('favicon size out of bounds')
  const dataUrl = await blobToDataUrl(blob)
  return { dataUrl, mediaType, sizeBytes: blob.size }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('favicon read failed'))
    reader.readAsDataURL(blob)
  })
}
