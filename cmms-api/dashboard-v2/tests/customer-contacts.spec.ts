// tests/customer-contacts.spec.ts
//
// Unit tests for src/lib/customerContacts.ts — the parser that splits
// the legacy cmms.db `TELEFON` / `E-MAIL` blobs into discrete contacts
// for the ticket inspector.
//
// The cmms.db stores every contact for a customer in a single
// semicolon-separated field (e.g. `"52-582721;Sőrés Zoltán:30-4034262;
// Kemecsei Bence:30-2198114"`). The inspector needs to render each
// contact as a row with its own tap target, so the blob must be
// parsed.

import { describe, expect, it } from 'vitest'
import {
  parseCustomerContacts,
  parseEmails,
  parsePhones,
} from '@/lib/customerContacts'

describe('parsePhones', () => {
  it('returns [] for null / empty / whitespace input', () => {
    expect(parsePhones(null)).toEqual([])
    expect(parsePhones(undefined)).toEqual([])
    expect(parsePhones('')).toEqual([])
    expect(parsePhones('   ')).toEqual([])
  })

  it('parses the main phone only (no separator)', () => {
    expect(parsePhones('52-582721')).toEqual([
      { name: null, value: '52-582721' },
    ])
  })

  it('parses "Name:Phone" pairs', () => {
    const input = 'Sőrés Zoltán:30-4034262;Kemecsei Bence:30-2198114'
    expect(parsePhones(input)).toEqual([
      { name: 'Sőrés Zoltán', value: '30-4034262' },
      { name: 'Kemecsei Bence', value: '30-2198114' },
    ])
  })

  it('parses the legacy form: main phone + named contacts', () => {
    const input =
      '52-582721;(Makszim Ferenc - már nem dolgozik ott) ' +
      'Sőrés Zoltán:30-4034262;Kemecsei Bence:30-2198114;Mikle Zoltán:30-7288268'
    const out = parsePhones(input)
    expect(out).toEqual([
      { name: null, value: '52-582721' },
      { name: 'Sőrés Zoltán', value: '30-4034262' },
      { name: 'Kemecsei Bence', value: '30-2198114' },
      { name: 'Mikle Zoltán', value: '30-7288268' },
    ])
  })

  it('parses "Name - Phone" (em-dash) form', () => {
    expect(parsePhones('Sőrés Zoltán - 30-4034262')).toEqual([
      { name: 'Sőrés Zoltán', value: '30-4034262' },
    ])
  })

  it('drops fragments that do not look like phones', () => {
    // Trailing fragment is a stray name; should be ignored.
    const input = '52-582721;Makszim Ferenc'
    expect(parsePhones(input)).toEqual([{ name: null, value: '52-582721' }])
  })

  it('deduplicates by normalized digit sequence', () => {
    // Same phone listed twice with different separators.
    const input = 'Sőrés Zoltán:30-403-4262;30 403 4262'
    const out = parsePhones(input)
    expect(out).toHaveLength(1)
    expect(out[0].value.replace(/[\s()+\-]/g, '')).toBe('304034262')
  })

  it('trims whitespace around fragments and values', () => {
    expect(parsePhones('  52-582721  ;  Sőrés Zoltán : 30-4034262  ')).toEqual([
      { name: null, value: '52-582721' },
      { name: 'Sőrés Zoltán', value: '30-4034262' },
    ])
  })
})

describe('parseEmails', () => {
  it('returns [] for null / empty input', () => {
    expect(parseEmails(null)).toEqual([])
    expect(parseEmails('')).toEqual([])
  })

  it('parses a list of emails', () => {
    const input =
      'roman.adam@hajduautort.hu;makszim.ferenc@hajduautort.hu;kemecsei.bence@hajduautort.hu'
    expect(parseEmails(input)).toEqual([
      { name: null, value: 'roman.adam@hajduautort.hu' },
      { name: null, value: 'makszim.ferenc@hajduautort.hu' },
      { name: null, value: 'kemecsei.bence@hajduautort.hu' },
    ])
  })

  it('drops fragments that do not look like emails', () => {
    const input = 'roman.adam@hajduautort.hu;not-an-email;kemecsei.bence@hajduautort.hu'
    expect(parseEmails(input)).toEqual([
      { name: null, value: 'roman.adam@hajduautort.hu' },
      { name: null, value: 'kemecsei.bence@hajduautort.hu' },
    ])
  })

  it('deduplicates by case-insensitive email', () => {
    const input = 'A@b.hu;a@b.hu;c@d.hu'
    const out = parseEmails(input)
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.value)).toEqual(['A@b.hu', 'c@d.hu'])
  })
})

describe('parseCustomerContacts', () => {
  it('combines phones and emails in one call', () => {
    const out = parseCustomerContacts(
      '52-582721;Sőrés Zoltán:30-4034262',
      'roman.adam@hajduautort.hu;kemecsei.bence@hajduautort.hu',
    )
    expect(out.phones).toEqual([
      { name: null, value: '52-582721' },
      { name: 'Sőrés Zoltán', value: '30-4034262' },
    ])
    expect(out.emails).toEqual([
      { name: null, value: 'roman.adam@hajduautort.hu' },
      { name: null, value: 'kemecsei.bence@hajduautort.hu' },
    ])
  })

  it('returns empty lists when both fields are null', () => {
    expect(parseCustomerContacts(null, null)).toEqual({
      phones: [],
      emails: [],
    })
  })
})
