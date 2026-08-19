// src/lib/feedback.ts
//
// Anonymous identity + feedback lib for the Ask Like/Dislike feature.
//
// Identity model: a per-browser UUID v4 stored in localStorage. We
// NEVER ask the user to sign in just to vote. The dashboard cookie
// already gates the API; the uid is a per-browser tiebreaker for
// the "one vote per (answer, user)" rule, and it's stable across
// reloads so a refresh keeps the active state.
//
// We use crypto.randomUUID() (available in all modern browsers and
// happy-dom ≥ 11). Fallback to a hand-rolled v4 if the API is missing
// (older test envs).

const STORAGE_KEY = 'cmms_uid'

function randomUuidV4(): string {
  // crypto.randomUUID returns a v4 like 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // Fallback: build a v4 from crypto.getRandomValues (still typed as
  // crypto in modern envs). The version bits (4xxx) and the variant
  // bits (8|9|a|b) are baked in.
  const buf = new Uint8Array(16)
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf)
  } else {
    for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256)
  }
  buf[6] = (buf[6] & 0x0f) | 0x40
  buf[8] = (buf[8] & 0x3f) | 0x80
  const hex: string[] = []
  for (let i = 0; i < 16; i++) hex.push(buf[i].toString(16).padStart(2, '0'))
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  )
}

/**
 * Get the current browser's anonymous uid, creating one if missing.
 * Returns the empty string in non-browser envs (SSR / tests without
 * localStorage).
 */
export function getOrCreateCmmsUid(): string {
  if (typeof window === 'undefined') return ''
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY)
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
      return existing.toLowerCase()
    }
    const fresh = randomUuidV4()
    window.localStorage.setItem(STORAGE_KEY, fresh)
    return fresh
  } catch {
    // localStorage can throw in private-mode browsers when storage
    // is disabled. Generate an in-memory uid and skip persistence.
    return randomUuidV4()
  }
}

/**
 * Clear the stored uid. Test-only — used by the feedback-store spec
 * to assert the "new uid on empty localStorage" branch.
 */
export function _resetCmmsUid(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
