// tests/ocr-tokens.spec.ts
//
// Unit tests for the sentence-builder tokenizer (photo-to-ask
// rework, 2026-08-24). Pure string work — no Tesseract involved.
//
// The contract that matters: the tokenizer NEVER decides what a
// token means. A photographed date must never become a machine id
// again ("2026" regression), so bare digit runs stay in `words`
// and only strong identifier shapes land in `ids`.

import { describe, expect, it } from 'vitest'
import { extractDetails } from '../src/lib/ocrTokens'

describe('extractDetails — the "2026" regression', () => {
  it('keeps a bare year in words, NOT ids', () => {
    const d = extractDetails('2026')
    expect(d.ids).toEqual([])
    expect(d.words).toEqual(['2026'])
  })

  it('keeps a full date as ONE word token with trailing dot trimmed', () => {
    const d = extractDetails('Gyartas: 2026.08.24.')
    expect(d.ids).toEqual([])
    expect(d.words).toContain('2026.08.24')
    // The "Gyartas:" label survives without its colon.
    expect(d.words).toContain('Gyartas')
  })

  it('never puts bare 4-6 digit runs into ids (legacy pickSerial behaviour)', () => {
    const d = extractDetails('10297 26057 42')
    expect(d.ids).toEqual([])
    for (const w of d.words) {
      expect(w).not.toMatch(/^M/)
      expect(w).not.toMatch(/^B\d{6,9}$/)
    }
  })
})

describe('extractDetails — identifier shapes go to ids', () => {
  it('detects M-dash and M-no-dash machine ids', () => {
    const d = extractDetails('SN: M-26057 tartozek M17191')
    expect(d.ids).toEqual(expect.arrayContaining(['M-26057', 'M17191']))
  })

  it('detects B-prefix sorszam and J-prefix sorszam', () => {
    const d = extractDetails('B2408001 J00123')
    expect(d.ids).toEqual(expect.arrayContaining(['B2408001', 'J00123']))
  })

  it('detects NCT model heads including the bare brand mark', () => {
    const d = extractDetails('NCT99 NCT-12 NCT')
    expect(d.ids).toEqual(expect.arrayContaining(['NCT99', 'NCT-12', 'NCT']))
  })

  it('removes id matches from words so no chip is offered twice', () => {
    const d = extractDetails('M-26057 M-26057')
    expect(d.ids).toEqual(['M-26057'])
    expect(d.words).not.toContain('M-26057')
  })

  it('caps ids at 8', () => {
    const text = Array.from({ length: 20 }, (_, i) => `M${10000 + i}`).join(' ')
    const d = extractDetails(text)
    expect(d.ids.length).toBe(8)
  })
})

describe('extractDetails — token hygiene', () => {
  it('trims edge punctuation but keeps internal punctuation intact', () => {
    const d = extractDetails('(3,5kW) SN:/ 40%')
    expect(d.words).toContain('3,5kW')
    expect(d.words).toContain('40%') // % is allowed to survive at edges
    expect(d.words).toContain('SN')
  })

  it('dedupes case-insensitively keeping first casing', () => {
    const d = extractDetails('Motor motor MOTOR')
    expect(d.words.filter((w) => w.toLocaleLowerCase() === 'motor').length).toBe(1)
  })

  it('drops single-character noise and pure punctuation rows', () => {
    const d = extractDetails('a . | - M-12345')
    expect(d.words).toEqual([])
    expect(d.ids).toEqual(['M-12345'])
  })

  it('preserves reading order in words', () => {
    const d = extractDetails('olaj nyomas 3,5kW szivattyu')
    expect(d.words).toEqual(['olaj', 'nyomas', '3,5kW', 'szivattyu'])
  })

  it('returns two empty arrays for empty / null-ish input', () => {
    expect(extractDetails('')).toEqual({ ids: [], words: [] })
    expect(extractDetails(undefined as unknown as string)).toEqual({ ids: [], words: [] })
  })

  it('caps words at 80', () => {
    const text = Array.from({ length: 120 }, (_, i) => `szó${i}`).join(' ')
    const d = extractDetails(text)
    expect(d.words.length).toBe(80)
  })
})
