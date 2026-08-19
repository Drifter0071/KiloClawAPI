// tests/use-my-corrections.spec.ts
//
// useMyCorrections composable — the cache that backs the
// "Visszajelzés elküldve ✓" inline state under a disliked answer.
// Mirrors tests/use-my-votes.spec.ts in shape.
//
//   - correctionFor(id) returns the cached { correction, created_at }
//     or null when nothing has been submitted yet.
//   - castLocal(id, c) writes to the in-memory + localStorage cache.
//   - clearLocal(id) drops the entry.
//   - On a fresh mount, the cache is hydrated from localStorage so
//     the "Visszajelzés elküldve" state survives page reloads (the
//     server is the source of truth, localStorage is the paint hint).
//   - trackIds() batches the network call; only missing ids are
//     fetched, and the response is merged into the cache.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useMyCorrections } from '../src/composables/useMyCorrections'

const CACHE_KEY = 'nct-feedback-my-corrections-v1'

function readPersisted(): Record<string, { correction: string; created_at: string }> {
  const raw = localStorage.getItem(CACHE_KEY)
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, { correction: string; created_at: string }>
}

function writePersisted(map: Record<string, { correction: string; created_at: string }>): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(map))
}

function clearPersisted(): void {
  localStorage.removeItem(CACHE_KEY)
}

const loadMyCorrectionsMock = vi.fn()

vi.mock('@/composables/useApi', () => ({
  useApi: () => ({
    loadMyCorrections: loadMyCorrectionsMock,
  }),
}))

beforeEach(() => {
  clearPersisted()
  loadMyCorrectionsMock.mockReset()
  loadMyCorrectionsMock.mockResolvedValue({ corrections: {} })
})

describe('useMyCorrections', () => {
  it('returns null for ids that have no correction', () => {
    const cm = useMyCorrections()
    expect(cm.correctionFor('01HXYZ')).toBeNull()
  })

  it('castLocal writes to the in-memory cache', () => {
    const cm = useMyCorrections()
    cm.castLocal('01HXYZ', { correction: 'A helyes', created_at: '2026-08-19T10:00:00.000Z' })
    expect(cm.correctionFor('01HXYZ')).toEqual({
      correction: 'A helyes',
      created_at: '2026-08-19T10:00:00.000Z',
    })
  })

  it('castLocal persists to localStorage so the state survives reload', () => {
    const cm = useMyCorrections()
    cm.castLocal('01HXYZ', { correction: 'A helyes', created_at: '2026-08-19T10:00:00.000Z' })
    const persisted = readPersisted()
    expect(persisted['01HXYZ']).toEqual({
      correction: 'A helyes',
      created_at: '2026-08-19T10:00:00.000Z',
    })
  })

  it('hydrates from localStorage on construction (reload path)', () => {
    writePersisted({
      '01HXYZ': { correction: 'A helyes', created_at: '2026-08-19T10:00:00.000Z' },
    })
    // New composable instance — simulates a fresh page load.
    const cm = useMyCorrections()
    expect(cm.correctionFor('01HXYZ')).toEqual({
      correction: 'A helyes',
      created_at: '2026-08-19T10:00:00.000Z',
    })
  })

  it('clearLocal drops the entry from cache and localStorage', () => {
    const cm = useMyCorrections()
    cm.castLocal('01HXYZ', { correction: 'x', created_at: 't' })
    expect(cm.correctionFor('01HXYZ')).not.toBeNull()
    cm.clearLocal('01HXYZ')
    expect(cm.correctionFor('01HXYZ')).toBeNull()
    expect(readPersisted()['01HXYZ']).toBeUndefined()
  })

  it('clearLocal on a non-existent id is a no-op', () => {
    const cm = useMyCorrections()
    expect(() => cm.clearLocal('01HNEVER')).not.toThrow()
    expect(cm.correctionFor('01HNEVER')).toBeNull()
  })

  it('trackIds fetches only missing ids and merges the response', async () => {
    // Pre-seed: '01HA' is in the cache, '01HB' is missing.
    const cm = useMyCorrections()
    cm.castLocal('01HA', { correction: 'A-old', created_at: '2026-08-19T09:00:00.000Z' })
    loadMyCorrectionsMock.mockResolvedValue({
      corrections: {
        '01HB': { correction: 'B', created_at: '2026-08-19T09:30:00.000Z' },
      },
    })
    cm.trackIds(['01HA', '01HB'])
    // Wait for the in-flight fetch.
    await new Promise((res) => setTimeout(res, 0))
    expect(loadMyCorrectionsMock).toHaveBeenCalledTimes(1)
    expect(loadMyCorrectionsMock).toHaveBeenCalledWith(['01HB'])
    expect(cm.correctionFor('01HA')).toEqual({ correction: 'A-old', created_at: '2026-08-19T09:00:00.000Z' })
    expect(cm.correctionFor('01HB')).toEqual({ correction: 'B', created_at: '2026-08-19T09:30:00.000Z' })
  })

  it('trackIds skips the network call when every id is already cached', async () => {
    const cm = useMyCorrections()
    cm.castLocal('01HA', { correction: 'A', created_at: 't' })
    cm.trackIds(['01HA'])
    await nextTick()
    expect(loadMyCorrectionsMock).not.toHaveBeenCalled()
  })

  it('trackIds is a no-op for an empty id list', async () => {
    const cm = useMyCorrections()
    cm.trackIds([])
    await nextTick()
    expect(loadMyCorrectionsMock).not.toHaveBeenCalled()
  })
})
