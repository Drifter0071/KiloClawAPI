// src/lib/ocrSerial.ts
//
// Phase 8 (2026-08-24), brainstorm idea A7 — photo-to-ask OCR.
// Pack 1 rework (2026-08-25): tuned Tesseract parameters, one shared
// worker (the old code spawned a fresh WASM worker per call), and a
// preprocessing CASCADE for photos of industrial screens whose moiré /
// flicker bands / glare previously produced garbage or nothing.
//
// Privacy unchanged: everything runs locally (Tesseract.js WASM).
// Only the composed question ever leaves the phone.
//
// Cascade shape (runOcrCascade):
//   1. 'original'  — sparse-text pass on the untouched source
//   2. 'threshold' — grayscale + row-band removal + adaptive threshold
//                    + polarity fix   (the anti-static workhorse)
//   3. 'clean'     — threshold + median speckle removal + morph close
// Early-stops as soon as a pass reads confidently; otherwise hands the
// variants to the caller for the human "which is readable?" picker.

import { OEM, PSM, createWorker } from 'tesseract.js'
import type { Worker as TesseractWorker } from 'tesseract.js'
import {
  loadImageToCanvas,
  buildVariants,
  type PhotoVariant,
} from './ocrPreprocess'

export interface OcrResult {
  /** Full text the worker recognized (whitespace-joined). */
  text: string
  /** Confidence from Tesseract, 0..1. */
  confidence: number
  /** The most likely machine serial we found, or null. */
  serial: string | null
  /** Every candidate we found, ranked by length (longer = more
   *  specific = more likely to be the right one). */
  candidates: string[]
}

export interface CascadeOutcome {
  /** Best result across the automatic passes. */
  best: OcrResult
  /** Which pass produced it ('original' | 'threshold' | 'clean'). */
  bestLabel: string
  /** True when even the best pass looks unreliable (<0.5 conf or no
   *  text) — the UI should offer the manual variant picker. */
  needsPicker: boolean
  /** Preprocessed alternatives for the picker (may be empty when the
   *  browser can't canvas — then there is nothing to offer). */
  variants: PhotoVariant[]
}

/** Hungarian plates / DPC-NC controller front panels / serial
 *  stickers tend to print the model identifier in three shapes:
 *   - M-26057           (M-dash-5digits)
 *   - M17191            (M + 5+ digits, no separator)
 *   - B24071711         (B + 8 digits, internal sorszam)
 *   - NCT99 / NCT-99    (model head)
 *   - 10297             (4-5 digit bare numbers)
 */
const PATTERNS: RegExp[] = [
  /\bM[-]?\d{4,8}\b/g,
  /\bB\d{6,9}\b/g,
  /\bJ\d{4,8}\b/g,
  /\bNCT[-]?\d{1,4}\b/gi,
  /\b\d{4,6}\b/g,
]

/** Pick the best candidate out of a list, ranked longest-first.
 *  Tiebreaker: the one that matches the M-prefix shape (most
 *  common on NCT controllers). */
export function pickSerial(candidates: string[]): string | null {
  if (candidates.length === 0) return null
  const sorted = [...new Set(candidates)].sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length
    const aIsM = /^M[-]?\d/.test(a)
    const bIsM = /^M[-]?\d/.test(b)
    if (aIsM !== bIsM) return aIsM ? -1 : 1
    return 0
  })
  return sorted[0] ?? null
}

function toResult(data: { text?: string; confidence?: number }): OcrResult {
  const text = data.text ?? ''
  const confidence =
    typeof data.confidence === 'number' ? data.confidence / 100 : 0
  const candidates: string[] = []
  for (const re of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      candidates.push(m[0])
    }
  }
  return { text, confidence, serial: pickSerial(candidates), candidates }
}

// ---------------------------------------------------------------------------
// Shared worker — created lazily, reused across photos and passes.
// Creating a Tesseract worker costs seconds (core fetch + lang data);
// the old per-call Tesseract.recognize() paid it EVERY photo. A simple
// promise-chain mutex serializes access since one WASM worker cannot
// run two recognitions concurrently.
// ---------------------------------------------------------------------------

let workerPromise: Promise<TesseractWorker> | null = null
let queue: Promise<unknown> = Promise.resolve()

function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    // Hungarian traineddata is REQUIRED (vezérlő/szervo/csere… words
    // and ő/ű/ú/é); eng stays in the mix for ASCII serial shapes.
    workerPromise = createWorker('hun+eng', OEM.LSTM_ONLY, {
      logger: () => {},
    }).catch((err) => {
      workerPromise = null // allow retry on next attempt
      throw err
    })
  }
  return workerPromise
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {}) // keep the chain alive after failures
  return run
}

async function recognizeWith(
  source: File | Blob | string,
  psm: PSM,
): Promise<OcrResult> {
  const worker = await getWorker()
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    // Phone photos carry no DPI metadata; without this hint Tesseract
    // assumes ~70dpi, decides the glyphs are noise-sized, and bails.
    user_defined_dpi: '300',
    preserve_interword_spaces: '1',
  })
  const { data } = await worker.recognize(source)
  return toResult(data)
}

/**
 * Single sparse-text recognition pass — the primitive behind both the
 * legacy API and the cascade's picker step. Sparse mode finds text
 * anywhere in the frame instead of trusting block segmentation, which
 * photographed controller layouts routinely break.
 */
export async function recognizeSerialFromImage(
  source: File | Blob | string,
  _options: { lang?: string; signal?: AbortSignal } = {},
): Promise<OcrResult> {
  return enqueue(() => recognizeWith(source, PSM.SPARSE_TEXT))
}

// ---------------------------------------------------------------------------
// Preprocessing cascade
// ---------------------------------------------------------------------------

/** Total wall-clock budget for the automatic passes. Each pass is a
 *  few seconds on a mid-range phone; past the budget we ship the best
 *  so far rather than freezing the processing spinner. */
const CASCADE_BUDGET_MS = 30_000
/** Minimum time needed to justify starting another pass. */
const PASS_MIN_MS = 5_000
/** Stop the cascade once a pass reads this confidently. */
const GOOD_ENOUGH = 0.6

function scoreOf(r: OcrResult): number {
  const words = r.text.trim().length === 0 ? 0 : r.text.trim().split(/\s+/).length
  return r.confidence * 100 + Math.min(20, words)
}

function releaseVariants(variants: PhotoVariant[]): void {
  for (const v of variants) URL.revokeObjectURL(v.url)
}

export { releaseVariants }

/**
 * Run the automatic cascade over one photo. Never throws for "bad
 * image quality" — it always returns its best effort plus enough
 * context (`needsPicker`, `variants`) for the UI to escalate to the
 * human picker. Throws only on hard failures (worker OOM, etc.).
 */
export async function runOcrCascade(
  source: File | Blob,
): Promise<CascadeOutcome> {
  const startedAt = Date.now()

  // Build preprocessed variants up front; if canvas is unavailable
  // (old webview, tests) we degrade to original-only gracefully.
  let variants: PhotoVariant[] = []
  try {
    variants = await buildVariants(await loadImageToCanvas(source))
  } catch {
    variants = []
  }

  const byLabel = new Map<string, Blob>([['original', source]])
  for (const v of variants) byLabel.set(v.label, v.blob)

  const passOrder = ['original', 'threshold', 'clean'].filter((l) =>
    byLabel.has(l),
  )

  let best: OcrResult | null = null
  let bestLabel = passOrder[0] ?? 'original'
  for (const label of passOrder) {
    if (Date.now() - startedAt > CASCADE_BUDGET_MS - PASS_MIN_MS && best) break
    const result = await enqueue(() => recognizeWith(byLabel.get(label)!, PSM.SPARSE_TEXT))
    if (!best || scoreOf(result) > scoreOf(best)) {
      best = result
      bestLabel = label
    }
    const hasText = result.text.trim().length > 0
    if (result.confidence >= GOOD_ENOUGH && hasText) break
  }

  const finalBest = best ?? {
    text: '',
    confidence: 0,
    serial: null,
    candidates: [],
  }
  const needsPicker =
    finalBest.confidence < 0.5 || finalBest.text.trim().length === 0

  return {
    best: finalBest,
    bestLabel,
    needsPicker,
    variants,
  }
}
