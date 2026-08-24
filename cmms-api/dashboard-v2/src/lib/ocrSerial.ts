// src/lib/ocrSerial.ts
//
// Phase 8 (2026-08-24), brainstorm idea A7 — photo-to-ask OCR.
// Runs Tesseract.js in the browser to extract text from a machine
// plate photo, then picks the most likely serial number out of
// the recognized lines. The serial candidates are matched against
// the same shape the rest of the CMMS already uses: M- or M prefix
// with 4-8 digits, or a compact id like M17191, B2408001, J00001.
//
// We do NOT make a server call here — the OCR runs locally
// (Tesseract.js WASM worker, ~1.5MB one-time download). The
// recognized text stays in the browser; only the extracted serial
// is forwarded to AskPage.

import Tesseract from 'tesseract.js'

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

// Hungarian plates / DPC-NC controller front panels / serial
// stickers tend to print the model identifier in three shapes:
//   - M-26057           (M-dash-5digits)
//   - M17191            (M + 5+ digits, no separator)
//   - B24071711         (B + 8 digits, internal sorszam — likely a
//                        ticket number printed on a label, not a
//                        machine id, but we still surface it)
//   - NCT99 / NCT-99    (model head)
//   - 10297             (4-5 digit bare numbers — also common on
//                        plates, often the production id)
//
// We accept ALL of these and return the first one we find, ranked
// longest-first (more specific). The AskPage can then choose to
// scope the question to whichever shape the operator wanted.
const PATTERNS: RegExp[] = [
  // M- or M followed by 4-8 digits (M-prefix machine id).
  /\bM[-]?\d{4,8}\b/g,
  // B-prefix 8-digit (CMMS sorszam, used on internal labels).
  /\bB\d{6,9}\b/g,
  // J-prefix (older internal sorszam).
  /\bJ\d{4,8}\b/g,
  // NCT + optional separator + 1-4 digits (model head).
  /\bNCT[-]?\d{1,4}\b/gi,
  // Bare 4-6 digit production ids.
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

/** Run OCR on the given image (File, Blob, or data URL).
 *  Returns the recognized text + the best serial candidate. */
export async function recognizeSerialFromImage(
  source: File | Blob | string,
  options: { lang?: string; signal?: AbortSignal } = {},
): Promise<OcrResult> {
  const lang = options.lang ?? 'eng'
  // Tesseract.js auto-downloads the traineddata on first use; for
  // Hungarian plates we can layer `hun` too but the cost is a
  // second ~3MB download. Stick with `eng` by default — model
  // numbers are ASCII.
  const { data } = await Tesseract.recognize(source, lang, {
    logger: () => {}, // silence the per-row progress log
  })
  const text = data.text ?? ''
  const confidence = typeof data.confidence === 'number' ? data.confidence / 100 : 0
  const candidates: string[] = []
  for (const re of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      candidates.push(m[0])
    }
  }
  const serial = pickSerial(candidates)
  return { text, confidence, serial, candidates }
}
