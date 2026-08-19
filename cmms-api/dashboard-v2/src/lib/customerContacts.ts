// src/lib/customerContacts.ts
//
// Parse the legacy `TELEFON` and `E-MAIL` customer fields into a
// structured list of contact entries.
//
// The cmms.db source stores all phones / emails in TWO single string
// fields, separated by `;` and `:`. For example:
//
//   TELEFON: "52-582721;Sőrés Zoltán:30-4034262;Kemecsei Bence:30-2198114;..."
//   E-MAIL:  "roman.adam@hajduautort.hu;makszim.ferenc@hajduautort.hu;..."
//
// Dumping these raw into the ticket inspector's customer card creates
// a wall of text that's unreadable. This module splits the strings
// into discrete contacts so the UI can render each as a row with a
// tappable phone / mailto link.
//
// Parsing rules:
//   1. Split on `;` first → list of fragments
//   2. For each fragment:
//      - If it contains a `:` and the LHS looks like a name
//        (letters / accents / space / dot), split it as `name:phone`
//        or `name:email`. The RHS is the actual phone or email.
//      - If it has no `:` and looks like a phone (digits + dashes +
//        parens), it's a "main" phone with no name.
//      - If it has no `:` and looks like an email, it's a generic
//        email with no name.
//      - Otherwise (a bare token with no clear type), drop it.
//
// We DON'T try to align phones with emails (they're stored in two
// separate fields and the legacy data isn't always consistent). The
// UI renders phones and emails as two separate lists.
//
// Returns: { phones: Contact[], emails: Contact[] } where each
// contact is { name: string | null, value: string }.

const NAME_RE = /^[\p{L}][\p{L}\p{M}\s.'-]{0,40}$/u
// Looks like a phone: at least 4 digits, optional separators.
const PHONE_RE = /^[\d()+\-\s]{4,}$/
// Looks like an email: contains @ and a dot after the @.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface CustomerContact {
  name: string | null
  value: string
}

export interface ParsedCustomerContacts {
  phones: CustomerContact[]
  emails: CustomerContact[]
}

/**
 * Split a `;`-separated phone blob into discrete contacts.
 * The first fragment with no `:` is treated as the "main" phone
 * (no name) — that matches how the legacy data starts with the
 * company's main line before listing named contacts.
 */
export function parsePhones(raw: string | null | undefined): CustomerContact[] {
  if (!raw) return []
  const out: CustomerContact[] = []
  const seen = new Set<string>()
  for (const frag of raw.split(';')) {
    // Drop parenthesized free-text comments first (e.g.
    // "(Makszim Ferenc - már nem dolgozik ott)") so they don't
    // break the name+phone split on the rest of the fragment.
    const trimmed = stripParenComments(frag.trim())
    if (!trimmed) continue
    const contact = parseOnePhone(trimmed)
    if (!contact) continue
    // Dedupe by value. Same phone listed twice in the legacy data
    // (once with name, once without) should only render once.
    const key = contact.value.replace(/[\s()+\-]/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(contact)
  }
  return out
}

/** Strip parenthesized free-text comments from a fragment.
 *  The legacy data has forms like
 *    "(Makszim Ferenc - már nem dolgozik ott) Sőrés Zoltán:30-4034262"
 *  where the paren is a comment about a previous (departed) contact.
 *  We drop the paren content but keep the rest of the fragment. */
function stripParenComments(frag: string): string {
  return frag.replace(/\([^)]*\)/g, '').trim()
}

/**
 * Split a `;`-separated email blob into discrete contacts.
 * Emails never have a name prefix in the legacy data — the
 * company-wide emails are just listed one after another.
 */
export function parseEmails(raw: string | null | undefined): CustomerContact[] {
  if (!raw) return []
  const out: CustomerContact[] = []
  const seen = new Set<string>()
  for (const frag of raw.split(';')) {
    const trimmed = frag.trim()
    if (!trimmed) continue
    if (!EMAIL_RE.test(trimmed)) continue
    const lc = trimmed.toLowerCase()
    if (seen.has(lc)) continue
    seen.add(lc)
    out.push({ name: null, value: trimmed })
  }
  return out
}

/** Parse a single phone fragment. Returns null if the fragment
 *  doesn't look like a phone at all (e.g. a stray name from a
 *  misaligned field). */
function parseOnePhone(frag: string): CustomerContact | null {
  // Case 1: "Name:Phone" or "Name - Phone" — split on the LAST `:`
  // (some names have spaces, but the LHS is letters, RHS is digits).
  // We try `:` first because that's the dominant format in the
  // legacy data; if that fails, we try ` - ` (em-dash form).
  if (frag.includes(':')) {
    const idx = frag.indexOf(':')
    const namePart = frag.slice(0, idx).trim()
    const valuePart = frag.slice(idx + 1).trim()
    if (NAME_RE.test(namePart) && PHONE_RE.test(valuePart)) {
      return { name: namePart || null, value: valuePart }
    }
    // Fall through — maybe the value isn't a phone (could be email?)
  }
  if (frag.includes(' - ')) {
    const idx = frag.indexOf(' - ')
    const namePart = frag.slice(0, idx).trim()
    const valuePart = frag.slice(idx + 3).trim()
    if (NAME_RE.test(namePart) && PHONE_RE.test(valuePart)) {
      return { name: namePart || null, value: valuePart }
    }
  }
  // No separator — treat as a "main" phone if it looks like a phone.
  if (PHONE_RE.test(frag)) {
    return { name: null, value: frag }
  }
  return null
}

/** Convenience: parse both phone + email fields in one call. */
export function parseCustomerContacts(
  phone: string | null | undefined,
  email: string | null | undefined,
): ParsedCustomerContacts {
  return {
    phones: parsePhones(phone),
    emails: parseEmails(email),
  }
}
