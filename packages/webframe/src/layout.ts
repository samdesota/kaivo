import type { Anchor, Rect, Slot } from './types';
import { WebframeError } from './types';

export function isRect(a: Anchor): a is Rect {
  return (
    typeof (a as Rect).x === 'number' &&
    typeof (a as Rect).y === 'number' &&
    typeof (a as Rect).w === 'number' &&
    typeof (a as Rect).h === 'number'
  );
}

export function resolveAnchor(
  anchor: Anchor,
  bounds: Rect,
  slots: readonly Slot[],
): Rect {
  if (isRect(anchor)) return { ...anchor };
  if ('slot' in anchor) {
    const s = slots.find((slot) => slot.name === anchor.slot);
    if (!s) {
      throw new WebframeError(
        'SLOT_NOT_FOUND',
        `Slot '${anchor.slot}' is not defined on this window`,
      );
    }
    return { ...s.rect };
  }
  // edge anchor
  const { edge, size } = anchor;
  switch (edge) {
    case 'top':
      return { x: 0, y: 0, w: bounds.w, h: size };
    case 'bottom':
      return { x: 0, y: Math.max(0, bounds.h - size), w: bounds.w, h: size };
    case 'left':
      return { x: 0, y: 0, w: size, h: bounds.h };
    case 'right':
      return { x: Math.max(0, bounds.w - size), y: 0, w: size, h: bounds.h };
  }
}

export function cssToDeviceRect(rect: Rect, dpr: number): Rect {
  return {
    x: Math.round(rect.x * dpr),
    y: Math.round(rect.y * dpr),
    w: Math.round(rect.w * dpr),
    h: Math.round(rect.h * dpr),
  };
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
