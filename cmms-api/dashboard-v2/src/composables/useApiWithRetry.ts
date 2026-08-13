// src/composables/useApiWithRetry.ts
//
// Pinia store + helper for the "cmms-api / network down" retry banner.
//
// Shape (kept stable from the Phase 2 skeleton — GlobalBanner.vue imports
// `{ state, hint, retryInSec, retry }` directly):
//
//   useApiState()             — Pinia store
//   withAutoRetry(queryFn)    — vue-query queryFn wrapper
//
// Detection rules (in priority order):
//
//   1. status === 0  (network failure / TypeError: Failed to fetch)
//        → state = 'network-down',   hint = 'Kapcsolódási hiba'
//
//   2. body.error === 'cmms-api unavailable'  (proxy 503 path)
//        → state = 'cmms-api-down',  hint = body.hint ?? body.detail ?? body.error
//
//   3. status >= 500  (any other server-side failure)
//        → state = 'cmms-api-down',  hint = body.hint ?? body.detail ?? body.error ?? 'Server error'
//
//   4. 4xx  (client error)
//        → leave the store alone, just re-throw so vue-query renders the page's error UI.
//
// Backoff: 5s, 15s, 30s, 60s — after 4 failed auto-retries (~110s) we give up
// and require the user to click "Retry now" in the banner. Manual retry resets
// the counter and immediately re-runs the most recent queryFn.

import { defineStore } from 'pinia'
import { ref } from 'vue'

// ---------------------------------------------------------------------------
// Types — keep in sync with src/lib/api.ts (ApiErrorBody + ApiError).
// We re-declare the narrow bits we actually inspect so this module has no
// circular dependency on lib/api.ts (useApi.ts will throw the same shape).
// ---------------------------------------------------------------------------

interface ApiErrorBody {
  status: number
  message: string
  body: unknown
}

interface CmmsApiError {
  error?: string
  detail?: string
  hint?: string
}

function isApiErrorBody(e: unknown): e is ApiErrorBody {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as Record<string, unknown>).status === 'number' &&
    typeof (e as Record<string, unknown>).message === 'string' &&
    'body' in (e as Record<string, unknown>)
  )
}

function getCmmsApiError(body: unknown): CmmsApiError | null {
  if (typeof body !== 'object' || body === null) return null
  return body as CmmsApiError
}

// ---------------------------------------------------------------------------
// Module-level state for the auto-retry loop. Single-window: only the
// most-recent failed query is tracked, so a stale query from an old page
// can't keep the banner wedged when the user has moved on.
// ---------------------------------------------------------------------------

let currentRetry: { fn: () => Promise<unknown>; attempts: number } | null = null
let retryTimeout: ReturnType<typeof setTimeout> | null = null
let countdownInterval: ReturnType<typeof setInterval> | null = null

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000]
const MAX_AUTO_ATTEMPTS = BACKOFF_MS.length // 4

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useApiState = defineStore('api-state', () => {
  const state = ref<'idle' | 'cmms-api-down' | 'network-down'>('idle')
  const hint = ref<string | null>(null)
  const retryInSec = ref<number | null>(null)

  // Stop the backoff timer and reset countdown. Called when a retry
  // succeeds, when the store returns to 'idle', and when the user
  // clicks "Retry now" (before re-running the query).
  function clearRetry() {
    if (retryTimeout !== null) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    if (countdownInterval !== null) {
      clearInterval(countdownInterval)
      countdownInterval = null
    }
    retryInSec.value = null
    currentRetry = null
  }

  // Manual retry from the banner. Resets the backoff counter and
  // immediately re-runs the most recent failed queryFn. If no query
  // is tracked (e.g. user clicked after a successful run), this is a no-op
  // — the banner just hides via state='idle'.
  async function retry() {
    const pending = currentRetry
    if (!pending) {
      // Nothing to re-run; reset the banner state and bail.
      state.value = 'idle'
      hint.value = null
      retryInSec.value = null
      return
    }
    // Stop the existing timer; we'll re-arm after the run either succeeds
    // or fails again.
    if (retryTimeout !== null) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    if (countdownInterval !== null) {
      clearInterval(countdownInterval)
      countdownInterval = null
    }
    retryInSec.value = null

    // Reset counter on manual retry — user gets the full 4 attempts again.
    pending.attempts = 0
    currentRetry = { fn: pending.fn, attempts: 0 }
    try {
      await pending.fn()
      // Success path: runQuery's success branch will have already called
      // clearRetry() and set state='idle'. Nothing more to do here.
    } catch {
      // runQuery's failure branch handles state + backoff re-arm.
    }
  }

  return { state, hint, retryInSec, retry }
})

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

// One-second countdown that writes retryInSec. The banner shows it as
// "Retrying in {N}s…". Stops itself when it hits 0.
function startCountdown(store: ReturnType<typeof useApiState>, totalMs: number) {
  if (countdownInterval !== null) {
    clearInterval(countdownInterval)
  }
  let remaining = Math.ceil(totalMs / 1000)
  store.retryInSec = remaining
  countdownInterval = setInterval(() => {
    remaining -= 1
    if (remaining <= 0) {
      store.retryInSec = 0
      if (countdownInterval !== null) {
        clearInterval(countdownInterval)
        countdownInterval = null
      }
    } else {
      store.retryInSec = remaining
    }
  }, 1_000)
}

// Schedule the next auto-retry. If we've used all attempts, leave
// retryInSec=null so the banner shows the manual "Retry now" button.
function scheduleNextRetry(
  store: ReturnType<typeof useApiState>,
  fn: () => Promise<unknown>,
  attempts: number,
) {
  if (attempts >= MAX_AUTO_ATTEMPTS) {
    // Out of automatic retries. Keep state/hint as-is, drop the countdown
    // so the banner switches to the manual button.
    store.retryInSec = null
    currentRetry = { fn, attempts }
    return
  }
  const delay = BACKOFF_MS[attempts]!
  currentRetry = { fn, attempts }
  startCountdown(store, delay)
  retryTimeout = setTimeout(async () => {
    retryTimeout = null
    if (countdownInterval !== null) {
      clearInterval(countdownInterval)
      countdownInterval = null
    }
    store.retryInSec = null
    const pending = currentRetry
    if (!pending) return
    pending.attempts += 1
    try {
      await pending.fn()
      // Success — wipe the banner state and stop the loop.
      store.state = 'idle'
      store.hint = null
      store.retryInSec = null
      currentRetry = null
    } catch (e) {
      // Re-classify the failure. If it's a 4xx the original queryFn
      // chose to throw non-transport (e.g. a bug), don't arm another
      // backoff — just leave the banner as-is and let the next user
      // action re-trigger.
      const classification = classifyError(e)
      if (!classification) {
        return
      }
      store.state = classification.state
      store.hint = classification.hint
      scheduleNextRetry(store, pending.fn, pending.attempts)
    }
  }, delay)
}

// Classify the thrown error and return either 'cmms-api-down' or
// 'network-down' plus the hint to display. Returns null for 4xx — the
// wrapper should leave the store alone in that case.
function classifyError(e: unknown): { state: 'cmms-api-down' | 'network-down'; hint: string } | null {
  // Native fetch network failure surfaces as TypeError("Failed to fetch")
  // (Chromium) or "NetworkError when attempting to fetch resource" (Firefox).
  // Wrap it as status: 0 so the rest of the pipeline is uniform.
  let err: ApiErrorBody
  if (isApiErrorBody(e)) {
    err = e
  } else if (e instanceof TypeError && /fetch/i.test(e.message)) {
    err = { status: 0, message: e.message, body: undefined }
  } else {
    return null
  }

  // Case 1: hard network failure.
  if (err.status === 0) {
    return { state: 'network-down', hint: 'Kapcsolódási hiba' }
  }

  // Case 2: proxy's cmms-api-unavailable 503.
  const body = getCmmsApiError(err.body)
  if (body?.error === 'cmms-api unavailable') {
    return {
      state: 'cmms-api-down',
      hint: body.hint ?? body.detail ?? body.error ?? 'cmms-api unavailable',
    }
  }

  // Case 3: any other 5xx.
  if (err.status >= 500) {
    return {
      state: 'cmms-api-down',
      hint: body?.hint ?? body?.detail ?? body?.error ?? 'Szerverhiba',
    }
  }

  // 4xx — client error, do not surface in the global banner.
  return null
}

// ---------------------------------------------------------------------------
// withAutoRetry — vue-query queryFn wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a vue-query queryFn so that transport-level failures (network down,
 * cmms-api 503, other 5xx) surface the global banner and trigger the
 * 5/15/30/60s backoff loop. 4xx errors pass through untouched so the page
 * can render its own error UI.
 *
 * Usage:
 *
 *   useQuery({
 *     queryKey: ['answer', q],
 *     queryFn: withAutoRetry(() => useApi().answer({ q })),
 *   })
 */
export function withAutoRetry<T>(queryFn: () => Promise<T>): () => Promise<T> {
  return async (): Promise<T> => {
    const store = useApiState()
    // The store has to be touchable from any component, so grab the
    // singleton via the composable each call.
    try {
      const result = await queryFn()
      // Success — wipe the banner state. We deliberately don't touch
      // currentRetry here; clearRetry() (called below) will null it out.
      store.state = 'idle'
      store.hint = null
      // Stop the timer + countdown if they were running.
      if (retryTimeout !== null) {
        clearTimeout(retryTimeout)
        retryTimeout = null
      }
      if (countdownInterval !== null) {
        clearInterval(countdownInterval)
        countdownInterval = null
      }
      store.retryInSec = null
      currentRetry = null
      return result
    } catch (e) {
      const classification = classifyError(e)
      if (!classification) {
        // 4xx or non-transport error — leave the banner alone, just re-throw
        // so vue-query's error state renders the page's ErrorState component.
        throw e
      }
      // Transport-level failure. Update the store and arm the next backoff.
      store.state = classification.state
      store.hint = classification.hint

      // Figure out which attempt counter to use. If the same queryFn is
      // already the tracked one, increment; otherwise start fresh.
      const prior = currentRetry
      if (prior && prior.fn === queryFn) {
        scheduleNextRetry(store, queryFn, prior.attempts)
      } else {
        // A new queryFn took over (e.g. user typed a new question) — reset.
        currentRetry = { fn: queryFn, attempts: 0 }
        scheduleNextRetry(store, queryFn, 0)
      }
      throw e
    }
  }
}
