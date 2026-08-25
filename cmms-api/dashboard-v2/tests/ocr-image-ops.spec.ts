// tests/ocr-image-ops.spec.ts
//
// Pure pixel-math tests for the Fotó OCR preprocessing (Pack 1,
// 2026-08-25). No canvas, no Tesseract — just typed arrays, which is
// exactly why the ops live in lib/ocrImageOps.ts and lib/cropRect.ts.
//
// Each op targets a documented failure mode of photographed
// industrial screens:
//   removeRowBands        — flicker/moiré banding ("static")
//   adaptiveThresholdMean — glare / gradient illumination
//   medianFilter3         — sensor speckle
//   morphClose3           — strokes broken by thresholding
//   flipToDarkInk         — light-on-dark controller UIs

import { describe, expect, it } from 'vitest'
import {
  adaptiveThresholdMean,
  darkRatio,
  flipToDarkInk,
  grayFromRgba,
  medianFilter3,
  morphClose3,
  removeRowBands,
  rowBandEnergy,
  type ByteImage,
} from '../src/lib/ocrImageOps'
import {
  applyCornerDrag,
  clampRect,
  cornerAt,
  defaultCropRect,
  fullRect,
  insideRect,
  moveRect,
} from '../src/lib/cropRect'

function makeGray(
  width: number,
  height: number,
  fill: (x: number, y: number) => number,
): ByteImage {
  const data = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = fill(x, y)
  }
  return { data, width, height }
}

describe('removeRowBands', () => {
  it('suppresses horizontal band energy while keeping overall brightness', () => {
    // Base 180 with every 6th row dropped to 110 — classic flicker
    // banding. Text-like vertical structure: a bright column stripe.
    const w = 90
    const h = 72
    const banded = makeGray(w, h, (x, y) => {
      let v = 180
      if (y % 6 === 0) v = 110
      if (x > 30 && x < 50 && v === 180) v = 240 // "text" brighter than bg
      return v
    })
    const before = rowBandEnergy(banded)
    const cleaned = removeRowBands(banded)
    const after = rowBandEnergy(cleaned)
    expect(after).toBeLessThan(before * 0.2)

    // Overall brightness must be roughly preserved (we subtract the
    // BAND, not the content).
    let sumBefore = 0
    let sumAfter = 0
    for (let i = 0; i < banded.data.length; i += 1) {
      sumBefore += banded.data[i]!
      sumAfter += cleaned.data[i]!
    }
    const meanBefore = sumBefore / banded.data.length
    const meanAfter = sumAfter / cleaned.data.length
    expect(Math.abs(meanAfter - meanBefore)).toBeLessThan(12)

    // The bright column stripe survives (content is not cancelled).
    const stripe = cleaned.data[10 * w + 40]!
    expect(stripe).toBeGreaterThan(cleaned.data[10 * w + 5]!)
  })

  it('leaves an already-uniform image unchanged', () => {
    const flat = makeGray(50, 50, () => 128)
    const out = removeRowBands(flat)
    for (let i = 0; i < out.data.length; i += 1) {
      expect(Math.abs(out.data[i]! - 128)).toBeLessThanOrEqual(1)
    }
  })
})

describe('adaptiveThresholdMean', () => {
  it('keeps text strokes dark across a glare gradient that defeats global thresholds', () => {
    // Background ramps 90 -> 180 left-to-right; global thresholding
    // would either lose the dark side or fill the bright side.
    const w = 80
    const h = 40
    const img = makeGray(w, h, (x, y) => {
      // Two thin strokes (OCR-relevant shapes), spanning the gradient.
      if ((y >= 14 && y < 17 || y >= 24 && y < 27) && x >= 18 && x < 62) return 15
      return 90 + Math.round((x / (w - 1)) * 90)
    })
    const bin = adaptiveThresholdMean(img)
    // Stroke interiors stay dark on BOTH ends of the gradient.
    expect(bin.data[15 * w + 20]).toBe(0)
    expect(bin.data[15 * w + 58]).toBe(0)
    expect(bin.data[25 * w + 40]).toBe(0)
    // Background corners stay light.
    expect(bin.data[2 * w + 2]).toBe(255)
    expect(bin.data[2 * w + 77]).toBe(255)
    expect(bin.data[37 * w + 40]).toBe(255)
    // Dark-pixel count close to the true stroke area (2×3×44 = 264).
    const darkCount = darkRatio(bin) * w * h
    expect(darkCount).toBeGreaterThan(264 * 0.6)
    expect(darkCount).toBeLessThan(264 * 1.6)
  })
})

describe('medianFilter3', () => {
  it('removes isolated speckle but keeps solid strokes', () => {
    const img = makeGray(30, 30, () => 255)
    img.data[15 * 30 + 15] = 0 // single speckle
    // Solid 5x5 stroke that must survive.
    for (let y = 5; y < 10; y += 1) {
      for (let x = 5; x < 10; x += 1) img.data[y * 30 + x] = 0
    }
    const out = medianFilter3(img)
    expect(out.data[15 * 30 + 15]).toBe(255) // speckle gone
    expect(out.data[7 * 30 + 7]).toBe(0) // stroke core survives
  })
})

describe('morphClose3', () => {
  it('reconnects a 1px gap in a character stroke', () => {
    const img = makeGray(24, 24, () => 255)
    // Vertical bars at x=8 and x=10 — the gap column is x=9.
    for (let y = 4; y < 20; y += 1) {
      img.data[y * 24 + 8] = 0
      img.data[y * 24 + 10] = 0
    }
    const closed = morphClose3(img)
    expect(closed.data[11 * 24 + 9]).toBe(0) // gap filled mid-stroke
    // Far background untouched.
    expect(closed.data[2 * 24 + 2]).toBe(255)
  })
})

describe('flipToDarkInk', () => {
  it('inverts light-on-dark screens so ink is the dark minority', () => {
    const inverted = makeGray(20, 20, () => 30) // dark screen
    for (let y = 6; y < 14; y += 1) {
      for (let x = 4; x < 16; x += 1) inverted.data[y * 20 + x] = 220 // light text
    }
    const flipped = flipToDarkInk(inverted)
    expect(darkRatio(flipped)).toBeLessThan(0.5)
    expect(flipped.data[2 * 20 + 2]).toBe(255) // former bg now white
    expect(flipped.data[9 * 20 + 9]).toBe(0) // former text now black
  })

  it('passes already-dark-on-light images through', () => {
    const normal = makeGray(20, 20, () => 240)
    normal.data[100] = 10
    const same = flipToDarkInk(normal)
    expect(same.data[100]).toBe(10)
  })
})

describe('grayFromRgba', () => {
  it('computes luma and drops alpha', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 128, 0, 0, 0, 200])
    const g = grayFromRgba(rgba, 2, 1)
    expect(g.width).toBe(2)
    expect(g.data[0]).toBe(255)
    expect(g.data[1]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// cropRect math (Pack 1 A6)
// ---------------------------------------------------------------------------

describe('cropRect', () => {
  it('fullRect covers everything; defaultCropRect insets symmetrically', () => {
    expect(fullRect()).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const d = defaultCropRect()
    expect(d.x).toBeCloseTo(d.y)
    expect(d.w).toBeCloseTo(d.h)
    expect(d.x + d.w).toBeCloseTo(1 - d.x)
  })

  it('clampRect enforces bounds and minimum size', () => {
    const r = clampRect({ x: -0.2, y: 0.9, w: 2, h: 0.01 })
    expect(r.x).toBe(0)
    expect(r.w).toBeLessThanOrEqual(1)
    expect(r.h).toBeGreaterThanOrEqual(0.08)
    expect(r.y + r.h).toBeLessThanOrEqual(1)
  })

  it('applyCornerDrag se moves the bottom-right corner and keeps min size when inverted', () => {
    const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }
    const grown = applyCornerDrag(start, 'se', 0.9, 0.8)
    expect(grown.x).toBe(0.2)
    expect(grown.y).toBe(0.2)
    expect(grown.w).toBeCloseTo(0.7)
    expect(grown.h).toBeCloseTo(0.6)
    // Drag far past the top-left corner: rect shrinks to MIN, never flips.
    const tiny = applyCornerDrag(start, 'se', 0.05, 0.05)
    expect(tiny.w).toBeGreaterThanOrEqual(0.08)
    expect(tiny.h).toBeGreaterThanOrEqual(0.08)
  })

  it('applyCornerDrag nw moves the top-left edge without crossing the right edge', () => {
    const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }
    const moved = applyCornerDrag(start, 'nw', 0.05, 0.1)
    expect(moved.x).toBeCloseTo(0.05)
    expect(moved.x + moved.w).toBeCloseTo(0.6) // right edge pinned
    // Crossing past the right/bottom edges clamps instead of flipping.
    const clamped = applyCornerDrag(start, 'nw', 0.95, 0.95)
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(1)
    expect(clamped.w).toBeGreaterThanOrEqual(0.08)
  })

  it('moveRect translates and clamps inside the image', () => {
    const start = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }
    const moved = moveRect(start, 0.05, 0.02)
    expect(moved.x).toBeCloseTo(0.15)
    expect(moved.y).toBeCloseTo(0.12)
    expect(moved.w).toBe(0.3)
    expect(moved.h).toBe(0.3)
    const pushed = moveRect(start, 5, 5)
    expect(pushed.x + pushed.w).toBeCloseTo(1)
    expect(pushed.y + pushed.h).toBeCloseTo(1)
  })

  it('cornerAt finds the nearest handle within grab radius, else null', () => {
    const r = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
    expect(cornerAt(r, 0.27, 0.26)).toBe('nw')
    expect(cornerAt(r, 0.72, 0.73)).toBe('se')
    expect(cornerAt(r, 0.5, 0.5)).toBeNull() // center: move zone, not a corner
    expect(cornerAt(r, 0.01, 0.99)).toBeNull() // nowhere near
    expect(insideRect(r, 0.5, 0.5)).toBe(true)
    expect(insideRect(r, 0.1, 0.5)).toBe(false)
  })
})
