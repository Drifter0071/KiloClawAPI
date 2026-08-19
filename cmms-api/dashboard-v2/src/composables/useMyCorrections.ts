// src/composables/useMyCorrections.ts
//
// Pre-hydrate the user's "Visszajelzés elküldve" state for the
// rendered Ask bubbles. Mirrors useMyVotes: a single
// GET /v1/feedback/my-corrections call covers every visible
// answer_id, so each bubble can render the right state on first paint
// — without the user re-submitting after a reload.
//
// Cache strategy:
//   - In-memory Map<answer_id, { correction, created_at }>
//   - LocalStorage-backed so the "Visszajelzés elküldve" state
//     survives page reload, just like the thumb buttons. The server
//     is the source of truth; localStorage is a paint hint.
//   - `castLocal(id, correction, created_at)` is called from AskPage
//     after the user submits a correction, so the cache stays in
//     sync without a re-fetch. `clearLocal(id)` is called when the
//     user un-dislikes the answer (no correction can exist for a
//     non-disliked answer — we drop the cached entry to avoid a
//     stale "Visszajelzés elküldve" label on a freshly-liked
//     answer).
//
// The composable returns a single `correctionFor(id)` accessor;
// consumers don't need to think about batching.

import { ref, watch, type Ref } from 'vue'
import { useApi } from '@/composables/useApi'

export interface MyCorrection {
  correction: string
  created_at: string
}

const CACHE_KEY = 'nct-feedback-my-corrections-v1'

function readPersisted(): Record<string, MyCorrection> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const j = JSON.parse(raw) as unknown
    if (!j || typeof j !== 'object') return {}
    const out: Record<string, MyCorrection> = {}
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (
        v && typeof v === 'object' &&
        typeof (v as { correction?: unknown }).correction === 'string' &&
        typeof (v as { created_at?: unknown }).created_at === 'string'
      ) {
        const { correction, created_at } = v as { correction: string; created_at: string }
        out[k] = { correction, created_at }
      }
    }
    return out
  } catch {
    return {}
  }
}

function writePersisted(map: Record<string, MyCorrection>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(map))
  } catch {
    /* quota / private mode — ignore */
  }
}

const corrections: Ref<Record<string, MyCorrection>> = ref(readPersisted())
let lastFetchedIds: string[] = []
let inFlight: Promise<void> | null = null

async function refreshFor(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  // Skip the round-trip if we already have every id cached. (Cheap
  // first-paint, even before the network finishes.)
  const missing = ids.filter((id) => !(id in corrections.value))
  if (missing.length === 0) return
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const api = useApi()
      // The server caps at 200 ids per call; we never have that many
      // in a single chat, but be defensive.
      const slice = missing.slice(0, 200)
      const res = await api.loadMyCorrections(slice)
      const next = { ...corrections.value }
      for (const [id, c] of Object.entries(res.corrections)) {
        next[id] = c
      }
      corrections.value = next
      writePersisted(next)
      lastFetchedIds = ids
    } catch {
      // Non-fatal: the inline link falls back to "not yet sent" if
      // the cache doesn't have an entry.
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function useMyCorrections() {
  /**
   * Reactive accessor: returns the user's submitted correction for
   * `id` (or null when none has been submitted). Components that
   * depend on this should also call `trackIds()` once with the
   * full list of answer_ids they will render so the composable
   * knows what to batch-fetch.
   */
  function correctionFor(id: string | null | undefined): MyCorrection | null {
    if (!id) return null
    return corrections.value[id] ?? null
  }

  /**
   * Local optimistic write. Called from AskPage after the server
   * round-trip succeeds, so the next time a bubble with the same id
   * mounts it renders "Visszajelzés elküldve" without a re-fetch.
   */
  function castLocal(id: string, c: MyCorrection): void {
    if (!id) return
    const next = { ...corrections.value }
    next[id] = c
    corrections.value = next
    writePersisted(next)
  }

  /**
   * Drop a cached correction. Called when the user un-dislikes an
   * answer: even if a previous correction exists on the server, the
   * inline link in the UI is gated on the dislike state, so we
   * remove the local entry to keep "is the link visible?" and "is
   * the correction state hydrated?" consistent.
   */
  function clearLocal(id: string): void {
    if (!id) return
    if (!(id in corrections.value)) return
    const next = { ...corrections.value }
    delete next[id]
    corrections.value = next
    writePersisted(next)
  }

  /**
   * Schedule a refresh for the given answer_ids. Cheap to call
   * repeatedly — it dedupes in-flight and skips already-cached ids.
   */
  function trackIds(ids: string[]): void {
    const sorted = [...ids].sort()
    if (sorted.length === lastFetchedIds.length && sorted.every((v, i) => v === lastFetchedIds[i])) {
      return
    }
    void refreshFor(sorted)
  }

  /**
   * Watch helper: reactively re-track when the id list changes
   * (e.g. a new answer lands in the chat, or the user scrolls to
   * reveal older bubbles).
   */
  function watchIds(getIds: () => string[]): ReturnType<typeof watch> {
    return watch(
      () => getIds().join('|'),
      () => trackIds(getIds()),
      { immediate: true, flush: 'post' },
    )
  }

  return { correctionFor, castLocal, clearLocal, trackIds, watchIds }
}
