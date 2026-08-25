// src/lib/ocrImageOps.ts
//
// Pure typed-array image operations for the Fotó OCR preprocessing
// cascade (Pack 1, 2026-08-25 brainstorm). No DOM access here — every
// function takes/returns plain byte buffers so the math is unit-
// testable in happy-dom (which has no real canvas implementation).
//
// Why these four ops: photographed industrial screens carry
//   - horizontal flicker/moiré bands  -> removeRowBands
//   - uneven glare                    -> adaptiveThresholdMean
//   - sensor speckle                  -> medianFilter3
//   - broken character strokes        -> morphClose3
// and controller UIs are often light-on-dark -> flipToDarkInk.

/** Single-channel image. `data` has exactly width*height bytes. */
export interface ByteImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** ITU-R 601 luma from an RGBA buffer. */
export function grayFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): ByteImage {
  const out = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; i < out.length; i += 1, j += 4) {
    out[i] = (rgba[j]! * 299 + rgba[j + 1]! * 587 + rgba[j + 2]! * 114) / 1000
  }
  return { data: out, width, height }
}

/**
 * Remove horizontal banding ("static"/scanlines) via row FLAT-FIELD:
 * estimate each row's mean brightness, take its WIDE moving baseline,
 * and subtract the difference. Narrow flicker/moiré bands sit far
 * below the wide baseline, so their full depth is subtracted away;
 * broad content (large dark UI bars, gradual glare gradients) is
 * absorbed INTO the baseline and left alone. Text strokes barely move
 * the row mean in the first place, so they ride through unchanged.
 */
export function removeRowBands(img: ByteImage): ByteImage {
  const { data, width, height } = img
  if (width === 0 || height === 0) return { data: new Uint8ClampedArray(data), width, height }
  const rowMean = new Float64Array(height)
  for (let y = 0; y < height; y += 1) {
    let sum = 0
    const off = y * width
    for (let x = 0; x < width; x += 1) sum += data[off + x]!
    rowMean[y] = sum / width
  }
  // Wide baseline: window must dwarf band thickness (~1-4 px) but
  // stay below UI-bar heights. h/8 works for both phone crops and
  // full-screen shots.
  const r = Math.max(4, Math.round(height / 8))
  const baseline = new Float64Array(height)
  for (let y = 0; y < height; y += 1) {
    let sum = 0
    let n = 0
    for (let k = -r; k <= r; k += 1) {
      const yy = y + k
      if (yy >= 0 && yy < height) {
        sum += rowMean[yy]!
        n += 1
      }
    }
    baseline[y] = sum / n
  }

  const out = new Uint8ClampedArray(data)
  for (let y = 0; y < height; y += 1) {
    const delta = rowMean[y]! - baseline[y]!
    if (delta === 0) continue
    const off = y * width
    for (let x = 0; x < width; x += 1) out[off + x] = data[off + x]! - delta
  }
  return { data: out, width, height }
}

/** Row-profile energy: variance of row means. A cheap "how banded is
 *  this image" metric (used by tests; kept exported for the eval
 *  harness). */
export function rowBandEnergy(img: ByteImage): number {
  const { data, width, height } = img
  if (width === 0 || height === 0) return 0
  const rowMean = new Float64Array(height)
  for (let y = 0; y < height; y += 1) {
    let sum = 0
    const off = y * width
    for (let x = 0; x < width; x += 1) sum += data[off + x]!
    rowMean[y] = sum / width
  }
  let m = 0
  for (let y = 0; y < height; y += 1) m += rowMean[y]!
  m /= height
  let v = 0
  for (let y = 0; y < height; y += 1) v += (rowMean[y]! - m) ** 2
  return v / height
}

/**
 * Mean-C adaptive threshold via integral image (Sauvola-lite). Each
 * pixel is compared against the mean of a local window minus C, so
 * gradient illumination / glare fields don't wipe out half the text.
 */
export function adaptiveThresholdMean(
  img: ByteImage,
  windowFrac = 1 / 12,
  C = 10,
): ByteImage {
  const { data, width, height } = img
  const out = new Uint8ClampedArray(width * height)
  if (width === 0 || height === 0) return { data: out, width, height }
  // Integral image with a zero padded top/left row+col (w+1)*(h+1).
  const integral = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0
    for (let x = 0; x < width; x += 1) {
      rowSum += data[y * width + x]!
      integral[(y + 1) * (width + 1) + (x + 1)] =
        integral[y * (width + 1) + (x + 1)]! + rowSum
    }
  }
  // Window must comfortably exceed stroke thickness (~2% of the min
  // side on plate text) so the local mean reflects BACKGROUND around
  // the stroke; floor of 15 keeps tiny crops working.
  const win = Math.max(15, Math.round(Math.min(width, height) * windowFrac) | 1) // odd
  const half = win >> 1
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - half)
    const y1 = Math.min(height - 1, y + half)
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - half)
      const x1 = Math.min(width - 1, x + half)
      const area = (y1 - y0 + 1) * (x1 - x0 + 1)
      const sum =
        integral[(y1 + 1) * (width + 1) + (x1 + 1)]! -
        integral[y0 * (width + 1) + (x1 + 1)]! -
        integral[(y1 + 1) * (width + 1) + x0]! +
        integral[y0 * (width + 1) + x0]!
      const mean = sum / area
      out[y * width + x] = data[y * width + x]! > mean - C ? 255 : 0
    }
  }
  return { data: out, width, height }
}

/** 3×3 majority (median-for-binary) filter — kills salt-and-pepper
 *  speckle without rounding character strokes. */
export function medianFilter3(img: ByteImage): ByteImage {
  const { data, width, height } = img
  const out = new Uint8ClampedArray(data)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let dark = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (data[(y + dy) * width + (x + dx)]! < 128) dark += 1
        }
      }
      out[y * width + x] = dark >= 5 ? 0 : 255
    }
  }
  return { data: out, width, height }
}

/**
 * Morphological CLOSE of the DARK phase (ink = 0/low values): MIN
 * filter dilates dark ink across small gaps, MAX erodes it back —
 * net effect reconnects strokes broken by thresholding without
 * thickening them. (Polarity note: with dark ink, dilation is the
 * MIN filter. max→min would close the BACKGROUND instead and eat
 * thin strokes.)
 */
export function morphClose3(img: ByteImage): ByteImage {
  const dilated = morphApply(img, Math.min)
  return morphApply(dilated, Math.max)
}

function morphApply(
  img: ByteImage,
  op: (a: number, b: number) => number,
): ByteImage {
  const { data, width, height } = img
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let v = data[y * width + x]!
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          v = op(v, data[yy * width + xx]!)
        }
      }
      out[y * width + x] = v
    }
  }
  return { data: out, width, height }
}

/**
 * Ensure ink is the DARK minority. Tesseract reads best dark-on-light;
 * controller screens are frequently the reverse. If more than half of
 * the binarized pixels are dark, invert.
 */
export function flipToDarkInk(img: ByteImage): ByteImage {
  let dark = 0
  for (let i = 0; i < img.data.length; i += 1) if (img.data[i]! < 128) dark += 1
  if (dark <= img.data.length / 2) return img
  const out = new Uint8ClampedArray(img.data.length)
  for (let i = 0; i < img.data.length; i += 1) out[i] = img.data[i]! < 128 ? 255 : 0
  return { data: out, width: img.width, height: img.height }
}

/** Dark-pixel ratio (test/debug helper). */
export function darkRatio(img: ByteImage): number {
  let dark = 0
  for (let i = 0; i < img.data.length; i += 1) if (img.data[i]! < 128) dark += 1
  return dark / img.data.length
}
