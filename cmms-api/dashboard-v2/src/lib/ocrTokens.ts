// src/lib/ocrTokens.ts
//
// Photo-to-ask rework (2026-08-24) — sentence-builder tokenization.
//
// The OLD flow picked a "most likely serial" and auto-composed a
// question like "[Gép: 2026] Kérem a gép előéletét." — photograph a
// date sticker and the year became the machine id.
//
// NEW contract: we never interpret. We only SPLIT what Tesseract read
// into tappable detail tokens; the technician taps them into a draft
// question and types freely in between. Pure string work — no OCR
// engine import here so tests don't need Tesseract.

export interface DetailTokens {
  /** Tokens shaped like an identifier (M-17191, B2408001, NCT99…).
   *  Strong shapes ONLY — bare digit runs (years, dates, pressures)
   *  are deliberately NOT here; they land in `words` instead, where
   *  the technician can decide what they mean. */
  ids: string[]
  /** All other readable tokens in reading order. */
  words: string[]
}

// Strong id shapes only. The legacy list in ocrSerial.ts also matched
// bare \d{4,6} runs — that is exactly what turned "2026" into a
// machine serial, so bare digits are excluded here.
const ID_PATTERNS: RegExp[] = [
  // M-prefix machine id: M-26057 / M26057
  /\bM[-]?\d{4,8}\b/g,
  // B-prefix CMMS sorszam on internal labels: B2408001
  /\bB\d{6,9}\b/g,
  // J-prefix older sorszam: J00123
  /\bJ\d{4,8}\b/g,
  // NCT model head: NCT99 / NCT-99 / plain NCT brand mark
  /\bNCT[-]?\w{1,6}\b|\bNCT\b/gi,
]

/** Trim anything that is not a letter/digit/% off a token's edges.
 *  Internal punctuation survives: "2026.08.24", "M-17191", "3,5kW". */
const EDGE_TRIM = /^[^A-Za-z0-9%]+|[^A-Za-z0-9%]+$/g

/** Split raw OCR text into tappable detail tokens.
 *  - whitespace split (also handles Tesseract's newlines)
 *  - edge punctuation trimmed ("SN:" -> "SN", "(2026)" -> "2026")
 *  - deduped case-insensitively (first occurrence keeps its casing)
 *  - 1-char noise dropped
 *  - identifier-shaped tokens promoted to `ids`, removed from `words`
 *  - caps: 8 ids, 80 words (a plate photo never has more) */
export function extractDetails(text: string): DetailTokens {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const rawTok of (text ?? '').split(/\s+/)) {
    const t = rawTok.replace(EDGE_TRIM, '')
    if (t.length < 2) continue
    if (!/[A-Za-z0-9]/.test(t)) continue
    const key = t.toLocaleLowerCase('hu')
    if (seen.has(key)) continue
    seen.add(key)
    tokens.push(t)
  }

  const ids: string[] = []
  const idSet = new Set<string>()
  for (const re of ID_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text ?? '')) !== null) {
      // Skip matches that only exist because they sit inside a longer
      // token we already trimmed differently — keep it simple: accept
      // the match if it survived trimming itself.
      const t = m[0].replace(EDGE_TRIM, '')
      if (t.length !== m[0].length) continue
      const key = t.toLocaleLowerCase('hu')
      if (idSet.has(key)) continue
      idSet.add(key)
      ids.push(t)
    }
  }

  const words = tokens.filter((t) => !idSet.has(t.toLocaleLowerCase('hu')))
  return { ids: ids.slice(0, 8), words: words.slice(0, 80) }
}
