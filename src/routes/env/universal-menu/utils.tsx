import type { UniversalMenuResult } from './types'

export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function displayPath(path: string, home: string | null | undefined): string {
  if (!home) return path
  const normalizedHome = home.replace(/\/+$/, '')
  const normalizedPath = path.replace(/\/+$/, '')
  if (normalizedPath === normalizedHome) return '~'
  if (normalizedPath.startsWith(`${normalizedHome}/`)) return `~/${normalizedPath.slice(normalizedHome.length + 1)}`
  return path
}

export function groupRow(id: string, label: string, depth: number, detail?: string): UniversalMenuResult {
  return { id, kind: 'action', label, detail, depth, disabled: true, haystack: label, run: () => undefined }
}

export function disabledRow(id: string, label: string): UniversalMenuResult {
  return { id, kind: 'action', label, haystack: label, disabled: true, run: () => undefined }
}

export function webQueryUrl(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  const candidate = hasScheme ? trimmed : trimmed.includes('.') || trimmed.startsWith('localhost') ? `https://${trimmed}` : ''
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}
