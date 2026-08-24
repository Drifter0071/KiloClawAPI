// tests/follow-ups.spec.ts
//
// Unit tests for the context-aware follow-up chip generator.
// The generator is a pure function: it takes the agent's final
// text + an optional device scope and returns 1-3 chips the user
// can tap to fire a follow-up question.

import { describe, expect, it } from 'vitest'
import { generateFollowUps } from '../src/lib/followUps'

describe('generateFollowUps', () => {
  it('returns the generic chips when the answer is too short', () => {
    // Anything < 20 chars: we don't even try to extract — the user
    // gets the 3 generic chips so there's always something to tap.
    const chips = generateFollowUps('OK.', null)
    expect(chips.length).toBe(3)
    expect(chips[0]!.id).toBe('more-on-this')
  })

  it('produces a sorszam-specific chip when the answer mentions one', () => {
    const chips = generateFollowUps(
      'A B24071711 ticketen a hiba oka egy kopott csapágy. Kicseréltük.',
      null,
    )
    expect(chips[0]).toBeDefined()
    expect(chips[0]!.id).toBe('sorszam-B24071711')
    expect(chips[0]!.text).toContain('B24071711')
  })

  it('produces a customer-specific chip when an UPPERCASE KFT is in the answer', () => {
    const chips = generateFollowUps(
      'A VÁMOSGÉP KFT. gépeinél gyakori a hűtőventilátor meghibásodása.',
      null,
    )
    const customerChip = chips.find((c) => c.id.startsWith('customer-'))
    expect(customerChip).toBeDefined()
    expect(customerChip!.text).toContain('ügyféltől')
  })

  it('caps the result at 3 chips', () => {
    const chips = generateFollowUps(
      'B24071711 — A VÁMOSGÉP KFT. jelezte, hogy 2024.05.10 óta fennáll a hiba. A 2026-os reklamációk száma nőtt.',
      'M17191',
    )
    expect(chips.length).toBeLessThanOrEqual(3)
  })

  it('falls back to generic chips when nothing concrete was found', () => {
    const chips = generateFollowUps('Röviden: ez egy általános tájékoztató a rendszer működéséről.', null)
    // No sorszam, no customer, no date → 3 generics
    expect(chips.length).toBe(3)
    expect(chips[0]!.id).toBe('more-on-this')
  })

  it('skips the device-status chip if the device is not mentioned in the answer', () => {
    const chips = generateFollowUps(
      'A másik gépen ugyanez a hiba jelentkezett, de M17191-re nincs most bejelentés.',
      'M99999',
    )
    const deviceChip = chips.find((c) => c.id === 'device-status')
    expect(deviceChip).toBeUndefined()
  })

  it('produces a date chip when a Hungarian date token is in the answer', () => {
    const chips = generateFollowUps(
      'Tavaly december óta háromszor jött ez a hiba.',
      null,
    )
    const dateChip = chips.find((c) => c.id === 'date-wider')
    expect(dateChip).toBeDefined()
  })
})
