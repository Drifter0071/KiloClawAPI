// scripts/ocr-eval.ts
//
// Pack 1 (2026-08-25) measurement harness for the Fotó OCR pipeline.
// Run REAL workshop photos through the SAME preprocessing recipes the
// app ships (band removal -> adaptive threshold -> denoise) plus the
// same Tesseract parameters, and score them against hand-typed ground
// truth with CER (character error rate). This turns engine/parameter
// tuning into engineering instead of vibes.
//
// Setup (one-time, dev machine only):
//   bun add -d @napi-rs/canvas      # JPEG/PNG decode for Node/Bun
//
// Usage:
//   bun scripts/ocr-eval.ts <photo-dir> [--out <dir>]
//
// Photo-dir layout:
//   m17191-screen.jpg          any number of photos
//   m17191-screen.gt.txt       optional ground truth ("what the screen
//                              actually says") — CER scored when present
//
// Outputs:
//   - console table: CER per photo per recipe (lower is better;
//     0 = perfect). Photos without .gt.txt show text length instead.
//   - <out>/<photo>.<recipe>.txt  raw OCR output for eyeballing
//   - summary: mean/min/max CER per recipe across scored photos
//
// NOTE: intentionally duplicates ~10 lines of pipeline constants from
// src/lib/ocrSerial.ts / ocrPreprocess.ts instead of importing them —
// this script must run in plain Node/Bun where there is no DOM canvas,
// while the browser modules legitimately depend on it. Keep the two
// in sync (the values are asserted against in unit tests).

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

import {
  adaptiveThresholdMean,
  flipToDarkInk,
  grayFromRgba,
  medianFilter3,
  morphClose3,
  removeRowBands,
  type ByteImage,
} from '../src/lib/ocrImageOps'
import { OEM, PSM, createWorker } from 'tesseract.js'

const MAX_SIDE = 1800
const MIN_WIDE = 900

interface RecipeOut {
  label: string
  png: Buffer | null // null => feed the original bytes untouched
}

async function main(): Promise<void> {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: bun scripts/ocr-eval.ts <photo-dir> [--out <dir>]')
    process.exit(1)
  }
  const outIdx = process.argv.indexOf('--out')
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1]! : join(dir, 'eval-out')
  mkdirSync(outDir, { recursive: true })

  let napi: typeof import('@napi-rs/canvas')
  try {
    napi = await import('@napi-rs/canvas')
  } catch {
    console.error('missing dependency. run:  bun add -d @napi-rs/canvas')
    process.exit(1)
  }

  const photos = readdirSync(dir).filter((f) =>
    ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(f).toLowerCase()),
  )
  if (photos.length === 0) {
    console.error(`no photos in ${dir}`)
    process.exit(1)
  }

  const worker = await createWorker('hun+eng', OEM.LSTM_ONLY, {
    logger: () => {},
  })
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
  })

  /** Decode + working-size scale, mirroring ocrPreprocess policy. */
  function decodeScaled(buf: Buffer): { rgba: Uint8ClampedArray; w: number; h: number } {
    const img = napi.loadImage(buf)
    let w = img.width
    let h = img.height
    let scale = Math.min(1, MAX_SIDE / Math.max(w, h))
    if (Math.max(w, h) * scale < MIN_WIDE) scale = Math.min(4, MIN_WIDE / Math.max(w, h))
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))
    const canvas = napi.createCanvas(w, h)
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    return { rgba: ctx.getImageData(0, 0, w, h).data, w, h }
  }

  function toPng(img: ByteImage): Buffer {
    const canvas = napi.createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')!
    const id = ctx.createImageData(img.width, img.height)
    for (let i = 0, j = 0; i < img.data.length; i += 1, j += 4) {
      id.data[j] = img.data[i]!
      id.data[j + 1] = img.data[i]!
      id.data[j + 2] = img.data[i]!
      id.data[j + 3] = 255
    }
    ctx.putImageData(id, 0, 0)
    return canvas.toBuffer('image/png')
  }

  function cer(a: string, b: string): number {
    const norm = (s: string) => s.toLocaleLowerCase('hu').replace(/\s+/g, ' ').trim()
    const x = norm(a)
    const y = norm(b)
    if (x.length === 0 && y.length === 0) return 0
    // Levenshtein, two-row DP.
    let prev = Array.from({ length: y.length + 1 }, (_, i) => i)
    for (let i = 1; i <= x.length; i += 1) {
      const cur = [i]
      for (let j = 1; j <= y.length; j += 1) {
        cur[j] = Math.min(
          prev[j]! + 1,
          cur[j - 1]! + 1,
          prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
        )
      }
      prev = cur
    }
    return prev[y.length]! / Math.max(x.length, y.length)
  }

  const rows: Array<{ name: string; scores: Record<string, number | null>; chars: Record<string, number> }> = []
  const cers: Record<string, number[]> = { original: [], threshold: [], clean: [] }

  for (const file of photos) {
    const base = basename(file, extname(file))
    const buf = readFileSync(join(dir, file))
    const gtPath = join(dir, `${base}.gt.txt`)
    const gt = exists(gtPath) ? readFileSync(gtPath, 'utf8') : null

    const decoded = decodeScaled(buf)
    const gray = removeRowBands(grayFromRgba(decoded.rgba, decoded.w, decoded.h))
    const thr = flipToDarkInk(adaptiveThresholdMean(gray))
    const clean = morphClose3(medianFilter3(thr))

    const recipes: RecipeOut[] = [
      { label: 'original', png: null }, // scaled original bytes
      { label: 'threshold', png: toPng(thr) },
      { label: 'clean', png: toPng(clean) },
    ]

    const scores: Record<string, number | null> = {}
    const chars: Record<string, number> = {}
    for (const r of recipes) {
      const input =
        r.png ?? (() => {
          // Re-encode the scaled original so every recipe sees the same size.
          const canvas = napi.createCanvas(decoded.w, decoded.h)
          const ctx = canvas.getContext('2d')!
          ctx.putImageData(new ImageDataLike(decoded.rgba, decoded.w, decoded.h), 0, 0)
          return canvas.toBuffer('image/png')
        })()
      const { data } = await worker.recognize(input)
      const text = (data.text ?? '').trim()
      chars[r.label] = text.length
      writeFileSync(join(outDir, `${base}.${r.label}.txt`), text, 'utf8')
      if (gt !== null) {
        const s = cer(gt, text)
        scores[r.label] = s
        cers[r.label]!.push(s)
      } else {
        scores[r.label] = null
      }
    }
    rows.push({ name: base, scores, chars })
  }

  // Console report
  const labels = ['original', 'threshold', 'clean']
  console.log('\nphoto'.padEnd(28) + labels.map((l) => l.padStart(11)).join(''))
  for (const row of rows) {
    const cells = labels
      .map((l) => {
        const s = row.scores[l]
        return s === null || s === undefined
          ? `${row.chars[l] ?? 0}ch`.padStart(11)
          : `${(s * 100).toFixed(1)}%`.padStart(11)
      })
      .join('')
    console.log(row.name.slice(0, 27).padEnd(28) + cells)
  }
  console.log('')
  for (const l of labels) {
    const arr = cers[l]!
    if (arr.length === 0) continue
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length
    console.log(
      `CER ${l.padEnd(10)} mean ${(mean * 100).toFixed(1)}%  min ${(Math.min(...arr) * 100).toFixed(1)}%  max ${(Math.max(...arr) * 100).toFixed(1)}%  n=${arr.length}`,
    )
  }
}

function exists(p: string): boolean {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}

/** Minimal ImageData stand-in for @napi-rs/canvas putImageData. */
class ImageDataLike {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
