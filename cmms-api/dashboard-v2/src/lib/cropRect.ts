// src/lib/cropRect.ts
//
// Pure rectangle math for the Fotó crop stage (Pack 1, 2026-08-25).
// Rects are NORMALIZED [0..1] against the displayed image so the same
// numbers map cleanly onto naturalWidth/naturalHeight at export time.
// Kept DOM-free for unit testing.

export interface CropRect {
  /** Left edge, 0..1 */
  x: number
  /** Top edge, 0..1 */
  y: number
  /** Width, 0..1 */
  w: number
  /** Height, 0..1 */
  h: number
}

export type Corner = 'nw' | 'ne' | 'se' | 'sw'

/** Full-image rect — what "A teljes képet olvasd" effectively uses. */
export function fullRect(): CropRect {
  return { x: 0, y: 0, w: 1, h: 1 }
}

/** Slight inset default so the user sees immediately that the rect is
 *  adjustable (and background clutter around the screen is already
 *  trimmed). */
export function defaultCropRect(inset = 0.06): CropRect {
  return { x: inset, y: inset, w: 1 - 2 * inset, h: 1 - 2 * inset }
}

const MIN_SIDE = 0.08

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Keep the rect inside the image and respect the minimum size. */
export function clampRect(r: CropRect): CropRect {
  const w = Math.min(1, Math.max(MIN_SIDE, r.w))
  const h = Math.min(1, Math.max(MIN_SIDE, r.h))
  const x = Math.min(1 - w, Math.max(0, r.x))
  const y = Math.min(1 - h, Math.max(0, r.y))
  return { x, y, w, h }
}

/** Drag one corner to a new normalized pointer position. */
export function applyCornerDrag(
  start: CropRect,
  corner: Corner,
  px: number,
  py: number,
): CropRect {
  const nx = clamp01(px)
  const ny = clamp01(py)
  const right = start.x + start.w
  const bottom = start.y + start.h
  switch (corner) {
    case 'nw':
      return clampRect({
        x: Math.min(nx, right - MIN_SIDE),
        y: Math.min(ny, bottom - MIN_SIDE),
        w: right - Math.min(nx, right - MIN_SIDE),
        h: bottom - Math.min(ny, bottom - MIN_SIDE),
      })
    case 'ne':
      return clampRect({
        x: start.x,
        y: Math.min(ny, bottom - MIN_SIDE),
        w: Math.max(MIN_SIDE, nx - start.x),
        h: bottom - Math.min(ny, bottom - MIN_SIDE),
      })
    case 'se':
      return clampRect({
        x: start.x,
        y: start.y,
        w: Math.max(MIN_SIDE, nx - start.x),
        h: Math.max(MIN_SIDE, ny - start.y),
      })
    case 'sw':
      return clampRect({
        x: Math.min(nx, right - MIN_SIDE),
        y: start.y,
        w: right - Math.min(nx, right - MIN_SIDE),
        h: Math.max(MIN_SIDE, ny - start.y),
      })
  }
}

/** Move the whole rect by a normalized delta (drag inside the frame). */
export function moveRect(start: CropRect, dx: number, dy: number): CropRect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy })
}

/** Which corner handle sits nearest this normalized point? Used to
 *  route a pointerdown to the right drag mode. Returns null when the
 *  press is outside every grab zone. */
export function cornerAt(
  r: CropRect,
  px: number,
  py: number,
  grab = 0.09,
): Corner | null {
  const corners: Array<[Corner, number, number]> = [
    ['nw', r.x, r.y],
    ['ne', r.x + r.w, r.y],
    ['se', r.x + r.w, r.y + r.h],
    ['sw', r.x, r.y + r.h],
  ]
  let best: Corner | null = null
  let bestDist = Infinity
  for (const [c, cx, cy] of corners) {
    // Aspect-agnostic distance in normalized space; grab radius is
    // generous because fingers are imprecise.
    const d = Math.hypot(px - cx, py - cy)
    if (d <= grab && d < bestDist) {
      best = c
      bestDist = d
    }
  }
  return best
}

/** True if the point is inside the rect body (move-drag zone). */
export function insideRect(r: CropRect, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
}
