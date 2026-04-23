import { useEffect, useState } from 'react'

const FONT_SIZE_KEY = 'ui.fontSizePx'
const DEFAULT_FONT_SIZE = 16
const MIN_FONT_SIZE = 12
const MAX_FONT_SIZE = 22

function applyFontSize(px: number): void {
  document.documentElement.style.setProperty('--app-font-size', `${px}px`)
}

export function readFontSize(): number {
  if (typeof window === 'undefined') return DEFAULT_FONT_SIZE
  const raw = window.localStorage.getItem(FONT_SIZE_KEY)
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) return DEFAULT_FONT_SIZE
  return n
}

export function initFontSize(): void {
  applyFontSize(readFontSize())
}

export function useFontSize(): [number, (px: number) => void] {
  const [size, setSize] = useState<number>(() => readFontSize())
  useEffect(() => {
    applyFontSize(size)
    try {
      window.localStorage.setItem(FONT_SIZE_KEY, String(size))
    } catch {
      // quota / disabled — ignore
    }
  }, [size])
  return [size, setSize]
}

export const FONT_SIZE_BOUNDS = { min: MIN_FONT_SIZE, max: MAX_FONT_SIZE, default: DEFAULT_FONT_SIZE }
