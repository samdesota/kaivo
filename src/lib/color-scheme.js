// Shared color utilities and palette definitions.
// Neutral colors intentionally share hue and saturation; only lightness changes.

export const sidebarNeutralBase = {
  // Derived from the workspace sidebar background: neutral-950 (#181a1f).
  h: 222.86,
  s: 20,
}

export const neutralLightness = {
  50: 98.04,
  100: 90.2,
  200: 80.98,
  300: 70.98,
  400: 55.1,
  500: 40,
  600: 34.12,
  700: 28.04,
  800: 20,
  900: 14.9,
  910: 14.08,
  920: 13.25,
  930: 12.43,
  940: 11.6,
  950: 10.78,
  960: 9.68,
  970: 8.59,
  975: 8.04,
}

export function hsl({ h, s, l }) {
  return `hsl(${round(h)} ${round(s)}% ${round(l)}%)`
}

export function makeNeutralScale(base = sidebarNeutralBase, lightness = neutralLightness) {
  return Object.fromEntries(
    Object.entries(lightness).map(([step, l]) => [step, hsl({ h: base.h, s: base.s, l })]),
  )
}

export const neutral = makeNeutralScale()

function round(value) {
  return Number.parseFloat(value.toFixed(2))
}
