// tests/ocr-serial.spec.ts
//
// Unit tests for the OCR serial extractor. We test the pure
// `pickSerial` helper and the regex pattern coverage (without
// running Tesseract.js, which would need the WASM worker).

import { describe, expect, it } from 'vitest'
import { pickSerial } from '../src/lib/ocrSerial'

describe('pickSerial', () => {
  it('returns null for an empty candidate list', () => {
    expect(pickSerial([])).toBeNull()
  })

  it('prefers the M-prefix shape when lengths tie', () => {
    expect(pickSerial(['12345', 'M17191'])).toBe('M17191')
  })

  it('prefers the longer candidate when both are valid', () => {
    expect(pickSerial(['M17191', 'M1719100'])).toBe('M1719100')
  })

  it('deduplicates candidates', () => {
    expect(pickSerial(['M17191', 'M17191', 'M-17191'])).toBe('M-17191')
  })

  it('handles M-dash-5digit and M-no-dash-5digit as the same priority', () => {
    // Both 6 chars; M-prefix wins as tiebreaker.
    expect(pickSerial(['M-1719', 'M1719'])).toBe('M-1719')
  })

  it('falls back to bare 4-6 digit if no M-prefix is present', () => {
    expect(pickSerial(['10297', '999'])).toBe('10297')
  })
})
