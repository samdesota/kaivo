import { useEffect, useState } from 'react'

const FONT_SIZE_KEY = 'ui.fontSizePx'
const COLOR_HUE_KEY = 'ui.colorHue'
const COLOR_SATURATION_KEY = 'ui.colorSaturation'
export const THEME_COLOR_CHANGE_EVENT = 'ui-theme-color-change'
const DEFAULT_FONT_SIZE = 16
const MIN_FONT_SIZE = 12
const MAX_FONT_SIZE = 22
const DEFAULT_COLOR_HUE = 222.86
const MIN_COLOR_HUE = 0
const MAX_COLOR_HUE = 360
const DEFAULT_COLOR_SATURATION = 20
const MIN_COLOR_SATURATION = 0
const MAX_COLOR_SATURATION = 50

function applyFontSize(px: number): void {
  document.documentElement.style.setProperty('--app-font-size', `${px}px`)
}

function applyThemeColor(color: ThemeColor): void {
  document.documentElement.style.setProperty('--app-color-hue', String(color.hue))
  document.documentElement.style.setProperty('--app-color-saturation', `${color.saturation}%`)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(THEME_COLOR_CHANGE_EVENT))
}

export type ThemeColor = {
  hue: number
  saturation: number
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

export function readThemeColor(): ThemeColor {
  if (typeof window === 'undefined') return { hue: DEFAULT_COLOR_HUE, saturation: DEFAULT_COLOR_SATURATION }
  const rawHue = window.localStorage.getItem(COLOR_HUE_KEY)
  const rawSaturation = window.localStorage.getItem(COLOR_SATURATION_KEY)
  const hue = rawHue ? Number(rawHue) : NaN
  const saturation = rawSaturation ? Number(rawSaturation) : NaN
  return {
    hue: Number.isFinite(hue) && hue >= MIN_COLOR_HUE && hue <= MAX_COLOR_HUE ? hue : DEFAULT_COLOR_HUE,
    saturation: Number.isFinite(saturation) && saturation >= MIN_COLOR_SATURATION && saturation <= MAX_COLOR_SATURATION ? saturation : DEFAULT_COLOR_SATURATION,
  }
}

export function initThemeColor(): void {
  applyThemeColor(readThemeColor())
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
export const COLOR_HUE_BOUNDS = { min: MIN_COLOR_HUE, max: MAX_COLOR_HUE, default: DEFAULT_COLOR_HUE }
export const COLOR_SATURATION_BOUNDS = { min: MIN_COLOR_SATURATION, max: MAX_COLOR_SATURATION, default: DEFAULT_COLOR_SATURATION }

export function useThemeColor(): [ThemeColor, (color: ThemeColor) => void] {
  const [color, setColor] = useState<ThemeColor>(() => readThemeColor())
  useEffect(() => {
    applyThemeColor(color)
    try {
      window.localStorage.setItem(COLOR_HUE_KEY, String(color.hue))
      window.localStorage.setItem(COLOR_SATURATION_KEY, String(color.saturation))
    } catch {
      // quota / disabled — ignore
    }
  }, [color])
  return [color, setColor]
}
