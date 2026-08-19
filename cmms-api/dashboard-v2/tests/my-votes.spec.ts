// tests/my-votes.spec.ts
//
// Tests for src/composables/useMyVotes.ts — the local vote-state
// cache that pre-hydrates the AnswerVoteBar before the server round
// trip lands. We assert the cache contract (voteFor / castLocal /
// trackIds) without depending on the network.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const { loadMyVotesMock } = vi.hoisted(() => ({ loadMyVotesMock: vi.fn() }))

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({ loadMyVotes: loadMyVotesMock }),
}))

// The composable reads localStorage on import. Stub it so each test
// starts with a clean cache.
const STORE = new Map<string, string>()
beforeEach(() => {
  STORE.clear()
  loadMyVotesMock.mockReset()
  // happy-dom exposes window.localStorage; we wire it through STORE.
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (k: string) => STORE.get(k) ?? null,
      setItem: (k: string, v: string) => { STORE.set(k, v) },
      removeItem: (k: string) => { STORE.delete(k) },
      clear: () => STORE.clear(),
      key: (i: number) => Array.from(STORE.keys())[i] ?? null,
      get length() { return STORE.size },
    },
    configurable: true,
  })
})

// Re-import the composable per test so the module-level `votes` ref
// starts empty. (Vitest module cache is shared otherwise.)
async function freshUseMyVotes() {
  vi.resetModules()
  const mod = await import('@/composables/useMyVotes')
  return mod.useMyVotes()
}

describe('useMyVotes', () => {
  it('returns 0 for an unknown id (no prior vote)', async () => {
    const { voteFor } = await freshUseMyVotes()
    expect(voteFor('a1')).toBe(0)
    expect(voteFor(null)).toBe(0)
    expect(voteFor(undefined)).toBe(0)
  })

  it('hydrates from localStorage on construction', async () => {
    STORE.set('nct-feedback-my-votes-v1', JSON.stringify({ a1: 1, a2: -1 }))
    const { voteFor } = await freshUseMyVotes()
    expect(voteFor('a1')).toBe(1)
    expect(voteFor('a2')).toBe(-1)
    expect(voteFor('a3')).toBe(0)
  })

  it('castLocal(1) adds a like; castLocal(0) removes it; castLocal(-1) switches to dislike', async () => {
    const { voteFor, castLocal } = await freshUseMyVotes()
    castLocal('a1', 1)
    expect(voteFor('a1')).toBe(1)
    // Localstorage-backed so reload re-hydrates the same state.
    const stored = JSON.parse(STORE.get('nct-feedback-my-votes-v1') ?? '{}') as Record<string, number>
    expect(stored.a1).toBe(1)
    castLocal('a1', -1)
    expect(voteFor('a1')).toBe(-1)
    castLocal('a1', 0)
    expect(voteFor('a1')).toBe(0)
    expect((JSON.parse(STORE.get('nct-feedback-my-votes-v1') ?? '{}') as Record<string, number>).a1)
      .toBeUndefined()
  })

  it('trackIds fetches missing ids via useApi().loadMyVotes and merges them in', async () => {
    loadMyVotesMock.mockResolvedValue({ votes: { a1: 1, a3: -1 } })
    const { voteFor, trackIds } = await freshUseMyVotes()
    trackIds(['a1', 'a2', 'a3'])
    // Wait for the in-flight promise to settle.
    await new Promise((r) => setTimeout(r, 10))
    await nextTick()
    expect(voteFor('a1')).toBe(1)
    expect(voteFor('a3')).toBe(-1)
    // a2 wasn't in the server response → still 0.
    expect(voteFor('a2')).toBe(0)
    // And the local cache persisted the merged state.
    const stored = JSON.parse(STORE.get('nct-feedback-my-votes-v1') ?? '{}') as Record<string, number>
    expect(stored.a1).toBe(1)
    expect(stored.a3).toBe(-1)
  })

  it('trackIds skips a round-trip when every id is already cached', async () => {
    loadMyVotesMock.mockResolvedValue({ votes: {} })
    const { trackIds } = await freshUseMyVotes()
    trackIds(['a1'])
    // Wait for the in-flight fetch + lastFetchedIds update to settle.
    await new Promise((r) => setTimeout(r, 20))
    await nextTick()
    expect(loadMyVotesMock).toHaveBeenCalledTimes(1)
    loadMyVotesMock.mockClear()
    // Re-tracking the same id should NOT trigger another fetch.
    trackIds(['a1'])
    await new Promise((r) => setTimeout(r, 20))
    await nextTick()
    expect(loadMyVotesMock).not.toHaveBeenCalled()
  })
})
