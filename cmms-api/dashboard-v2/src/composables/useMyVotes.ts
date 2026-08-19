// src/composables/useMyVotes.ts
//
// Pre-hydrate the user's 👍 / 👎 vote state for the rendered Ask
// bubbles. Batches all answer_ids currently in the chat into a single
// GET /v1/feedback/my-votes call so each AnswerVoteBar can render
// with the right initial state on first paint — without the user
// having to click and re-vote after a reload.
//
// Cache strategy:
//   - In-memory Map<answer_id, 1 | -1>
//   - LocalStorage-backed so the vote state survives page reload
//     (the server is the source of truth; this is just a paint hint)
//   - Vote / unvote / switch from AnswerVoteBar flows through
//     `castLocal()` so the cache stays in sync without a re-fetch
//
// The composable returns a single `voteFor(id)` accessor; consumers
// don't need to think about batching. The underlying fetch fires
// once per change in the rendered id set.

import { ref, watch, type Ref } from 'vue'
import { useApi } from '@/composables/useApi'

const CACHE_KEY = 'nct-feedback-my-votes-v1'

function readPersisted(): Record<string, 1 | -1> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const j = JSON.parse(raw) as unknown
    if (!j || typeof j !== 'object') return {}
    const out: Record<string, 1 | -1> = {}
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (v === 1 || v === -1) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writePersisted(map: Record<string, 1 | -1>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(map))
  } catch {
    /* quota / private mode — ignore */
  }
}

const votes: Ref<Record<string, 1 | -1>> = ref(readPersisted())
let lastFetchedIds: string[] = []
let inFlight: Promise<void> | null = null

async function refreshFor(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  // Skip the round-trip if we already have every id cached.
  const missing = ids.filter((id) => !(id in votes.value))
  if (missing.length === 0) return
  // Dedupe in-flight: if a fetch is already running, just wait on it.
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const api = useApi()
      // The server caps at 200 ids per call; we never have that many
      // in a single chat, but be defensive.
      const slice = missing.slice(0, 200)
      const res = await api.loadMyVotes(slice)
      const next = { ...votes.value }
      for (const [id, v] of Object.entries(res.votes)) {
        next[id] = v
      }
      votes.value = next
      writePersisted(next)
      lastFetchedIds = ids
    } catch {
      // Non-fatal: AnswerVoteBar falls back to "no prior vote" if the
      // cache doesn't have an entry.
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function useMyVotes() {
  /**
   * Reactive accessor: returns the user's current vote for `id`
   * (-1 / 0 / 1). 0 means "no prior vote" (the default).
   *
   * Components that depend on this should also call `trackIds()`
   * once with the full list of answer_ids they will render so the
   * composable knows what to batch-fetch.
   */
  function voteFor(id: string | null | undefined): -1 | 0 | 1 {
    if (!id) return 0
    return votes.value[id] ?? 0
  }

  /**
   * Local optimistic write. Called from AnswerVoteBar after the server
   * round-trip succeeds, so the next time a bar with the same id mounts
   * it renders the right active state.
   *
   * vote=0 means "unvoted" (we drop the key from the cache).
   */
  function castLocal(id: string, vote: -1 | 0 | 1): void {
    if (!id) return
    const next = { ...votes.value }
    if (vote === 0) delete next[id]
    else next[id] = vote
    votes.value = next
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
   * (e.g. new answer lands in the chat, or the user scrolls to
   * reveal older bubbles).
   */
  function watchIds(getIds: () => string[]): ReturnType<typeof watch> {
    return watch(
      () => getIds().join('|'),
      () => trackIds(getIds()),
      { immediate: true, flush: 'post' },
    )
  }

  return { voteFor, castLocal, trackIds, watchIds }
}
