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
