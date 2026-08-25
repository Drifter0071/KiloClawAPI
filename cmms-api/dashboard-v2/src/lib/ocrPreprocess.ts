// src/lib/ocrPreprocess.ts
//
// Canvas-side half of the Fotó OCR preprocessing cascade (Pack 1,
// 2026-08-25). Turns one photo into a small set of OCR-ready variants:
//
//   original   — untouched source (fast path for decent shots)
//   gray       — grayscale + row-band removal (for glare fields)
//   threshold  — gray + adaptive threshold + polarity fix (the workhorse)
//   clean      — threshold + median speckle removal + morph close
//
// All pixel math lives in ocrImageOps.ts (pure, testable); this file
// only decodes, resizes, and re-encodes. If canvas is unavailable
// (happy-dom, exotic webviews) buildVariants() degrades to [] and the
// cascade runs on the original alone.

import {
  adaptiveThresholdMean,
  flipToDarkInk,
  grayFromRgba,
  medianFilter3,
  morphClose3,
  removeRowBands,
  type ByteImage,
} from './ocrImageOps'

export interface PhotoVariant {
  /** Stable label used by the cascade + variant picker. */
  label: 'gray' | 'threshold' | 'clean'
  blob: Blob
  /** object: URL for <img> thumbnails in the picker UI. */
  url: string
}

/** Working-size policy: phone photos are 12+ MP; Tesseract wants
 *  ~30px x-height text, which at plate/screen crop sizes means a max
 *  side of roughly 1800–2200. Small images get ×2'd instead. */
const MAX_SIDE = 1800
const MIN_WIDE = 900

export async function loadImageToCanvas(
  source: Blob | string,
  maxSide = MAX_SIDE,
): Promise<HTMLCanvasElement> {
  const url =
    typeof source === 'string' ? source : URL.createObjectURL(source)
  try {
    const img = await decodeImage(url)
    let w = img.naturalWidth
    let h = img.naturalHeight
    if (w === 0 || h === 0) throw new Error('image-decode-empty')
    let scale = Math.min(1, maxSide / Math.max(w, h))
    if (Math.max(w, h) * scale < MIN_WIDE) scale = Math.min(4, MIN_WIDE / Math.max(w, h))
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas-unavailable')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    return canvas
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url)
  }
}

function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image-decode-failed'))
    img.src = url
  })
}

function byteImageToCanvas(img: ByteImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  const rgba = ctx.createImageData(img.width, img.height)
  for (let i = 0, j = 0; i < img.data.length; i += 1, j += 4) {
    rgba.data[j] = img.data[i]!
    rgba.data[j + 1] = img.data[i]!
    rgba.data[j + 2] = img.data[i]!
    rgba.data[j + 3] = 255
  }
  ctx.putImageData(rgba, 0, 0)
  return canvas
}

function grayOf(canvas: HTMLCanvasElement): ByteImage {
  const ctx = canvas.getContext('2d')!
  return grayFromRgba(
    ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    canvas.width,
    canvas.height,
  )
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('blob-encode-failed'))),
      'image/png',
    )
  })
}

/**
 * Build the preprocessed variants for one photo. Throws only when
 * canvas itself is unusable — callers treat that as "cascade on the
 * original only", not an error.
 */
export async function buildVariants(
  canvas: HTMLCanvasElement,
): Promise<PhotoVariant[]> {
  const gray = removeRowBands(grayOf(canvas))
  const thr = flipToDarkInk(adaptiveThresholdMean(gray))
  const clean = morphClose3(medianFilter3(thr))

  const made: Array<[PhotoVariant['label'], HTMLCanvasElement]> = [
    ['gray', byteImageToCanvas(gray)],
    ['threshold', byteImageToCanvas(thr)],
    ['clean', byteImageToCanvas(clean)],
  ]
  const out: PhotoVariant[] = []
  for (const [label, c] of made) {
    const blob = await canvasToBlob(c)
    out.push({ label, blob, url: URL.createObjectURL(blob) })
  }
  return out
}
