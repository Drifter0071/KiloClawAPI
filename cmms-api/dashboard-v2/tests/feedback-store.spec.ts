// tests/feedback-store.spec.ts
//
// Tiny unit suite for the cmms_uid helper (src/lib/feedback.ts).
//
// We assert:
//   - The UUID is a v4 (8-4-4-4-12 hex with the version + variant bits).
//   - It's stable across calls (no regeneration on re-read).
//   - It's restored from localStorage when present.
//   - It's NEW when localStorage is empty.
//   - _resetCmmsUid clears the storage.

import { describe, test, expect, beforeEach } from 'vitest'
import { getOrCreateCmmsUid, _resetCmmsUid } from '@/lib/feedback'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

beforeEach(() => {
  _resetCmmsUid()
})

describe('getOrCreateCmmsUid', () => {
  test('returns a UUID v4 when localStorage is empty', () => {
    const uid = getOrCreateCmmsUid()
    expect(uid).toMatch(UUID_V4)
  })

  test('is stable across calls (does not regenerate)', () => {
    const a = getOrCreateCmmsUid()
    const b = getOrCreateCmmsUid()
    const c = getOrCreateCmmsUid()
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  test('persists to localStorage under "cmms_uid"', () => {
    const uid = getOrCreateCmmsUid()
    expect(window.localStorage.getItem('cmms_uid')).toBe(uid)
  })

  test('re-uses an existing value from localStorage', () => {
    window.localStorage.setItem('cmms_uid', '11111111-2222-4333-8444-555555555555')
    const uid = getOrCreateCmmsUid()
    expect(uid).toBe('11111111-2222-4333-8444-555555555555')
  })

  test('rejects a malformed stored value and generates a fresh one', () => {
    window.localStorage.setItem('cmms_uid', 'not-a-uuid')
    const uid = getOrCreateCmmsUid()
    expect(uid).toMatch(UUID_V4)
    expect(uid).not.toBe('not-a-uuid')
  })

  test('lowercases the stored value (storage can be uppercase from another env)', () => {
    window.localStorage.setItem('cmms_uid', 'ABCDEF12-3456-4789-ABCD-EF1234567890')
    const uid = getOrCreateCmmsUid()
    expect(uid).toBe('abcdef12-3456-4789-abcd-ef1234567890')
  })

  test('_resetCmmsUid clears localStorage and a fresh uid is generated', () => {
    const a = getOrCreateCmmsUid()
    _resetCmmsUid()
    const b = getOrCreateCmmsUid()
    expect(a).toMatch(UUID_V4)
    expect(b).toMatch(UUID_V4)
    expect(b).not.toBe(a) // extremely unlikely to collide in 122 random bits
  })
})
