// src/composables/useSessionToken.ts
//
// Session-bearer-token helpers. v1 stored the dashboard token in
// sessionStorage under the key `cmms_dash_token` (login.html:133) so
// fetches could keep working if the session cookie ever expired. v2
// does the same — the login page writes it on a successful POST, and
// the api composable reads it on every fetch.
//
// Why a module-level helper instead of a Pinia store?
//   - The token must survive a Pinia store reset (e.g. HMR), so we
//     keep it in the same place v1 did: sessionStorage.
//   - No reactivity is needed: the token is read at fetch time, never
//     in a render path. Components that need the token just call
//     `getSessionToken()`.
//
// Keys are namespaced so a future second token (e.g. a write-token
// fallback) can share the helpers.

const FALLBACK_TOKEN = ''

export function getSessionToken(key = 'cmms_dash_token'): string {
  if (typeof window === 'undefined') return FALLBACK_TOKEN
  try {
    return window.sessionStorage.getItem(key) ?? FALLBACK_TOKEN
  } catch {
    // sessionStorage can throw in private-mode browsers when storage
    // is disabled. Fall through to the empty token — the cookie alone
    // is still enough for the session.
    return FALLBACK_TOKEN
  }
}

export function setSessionToken(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    // ignore — same rationale as getSessionToken
  }
}

export function clearSessionToken(key = 'cmms_dash_token'): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // ignore
  }
}
