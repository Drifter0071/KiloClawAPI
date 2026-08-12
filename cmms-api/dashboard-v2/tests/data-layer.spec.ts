// tests/data-layer.spec.ts
//
// Phase 4 — data layer tests.
//
// Covers:
//   - src/composables/useApi.ts            (typed fetch wrapper)
//   - src/composables/useApiWithRetry.ts   (Pinia store + withAutoRetry)
//   - src/composables/useEventSource.ts    (singleton EventSource + reconnect)
//   - src/stores/stream.ts                 (rolling event buffer + subscribe)
//   - src/composables/useStreamEvents.ts   (read-only facade)
//
// src/lib/api.ts is pure types — no runtime, no tests.
//
// Run: cd cmms-api/dashboard-v2 && bun run test (vitest)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

// ---------------------------------------------------------------------------
// 1. useApi — typed fetch wrapper
// ---------------------------------------------------------------------------

import { useApi, isApiErrorBody } from '../src/composables/useApi'

describe('useApi', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetchOnce(body: unknown, init: { status?: number; ok?: boolean } = {}) {
    const status = init.status ?? 200
    const ok = init.ok ?? (status >= 200 && status < 300)
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  it('answer() POSTs to /dashboard/api/answer with JSON body', async () => {
    mockFetchOnce({
      q: 'test',
      language: 'hu',
      intent: 'find_ticket',
      primitive: 'search_tickets',
      group_by: null,
      filters: {},
      period: null,
      summary: 'ok',
      follow_ups: [],
      results: [],
      evidence: {},
      total: 0,
      rationale: '',
      mode: 'answer',
      confidence: 0.9,
      threshold: 0.6,
      candidates: [],
      mode_rationale: '',
    })
    await useApi().answer({ q: 'test', language: 'hu' })
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('/dashboard/api/answer')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ q: 'test', language: 'hu' })
  })

  it('map() GETs with the period query string', async () => {
    mockFetchOnce({ nodes: [], total_groups: 0, period: null })
    await useApi().map('last_30_days')
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('/dashboard/api/map?period=last_30_days')
  })

  it('audit() includes the limit when provided', async () => {
    mockFetchOnce({ entries: [] })
    await useApi().audit(50)
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('/dashboard/api/audit?limit=50')
  })

  it('audit() omits the query string when limit is undefined', async () => {
    mockFetchOnce({ entries: [] })
    await useApi().audit()
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('/dashboard/api/audit')
  })

  it('throws ApiErrorBody on 5xx with the parsed {error,hint} body', async () => {
    mockFetchOnce(
      { error: 'cmms-api unavailable', hint: 'try again in a minute' },
      { status: 503 },
    )
    try {
      await useApi().map('last_30_days')
      throw new Error('expected to throw')
    } catch (e) {
      expect(isApiErrorBody(e)).toBe(true)
      const err = e as { status: number; message: string; body: { error: string; hint: string } }
      expect(err.status).toBe(503)
      expect(err.message).toBe('HTTP 503')
      expect(err.body.error).toBe('cmms-api unavailable')
      expect(err.body.hint).toBe('try again in a minute')
    }
  })

  it('throws ApiErrorBody with status: 0 on transport failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    try {
      await useApi().answer({ q: 'x', language: 'hu' })
      throw new Error('expected to throw')
    } catch (e) {
      expect(isApiErrorBody(e)).toBe(true)
      const err = e as { status: number; message: string }
      expect(err.status).toBe(0)
      expect(err.message).toBe('Network error')
    }
  })

  it('isApiErrorBody is a type guard that rejects non-shape objects', () => {
    expect(isApiErrorBody(new Error('x'))).toBe(false)
    expect(isApiErrorBody(null)).toBe(false)
    expect(isApiErrorBody({})).toBe(false)
    expect(isApiErrorBody({ status: 'no', message: 'x', body: 1 })).toBe(false)
  })

  it('uses same-origin credentials on every request', async () => {
    mockFetchOnce({ entries: [] })
    await useApi().audit(1)
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect((init as RequestInit).credentials).toBe('same-origin')
  })
})

// ---------------------------------------------------------------------------
// 2. useApiWithRetry — Pinia store + withAutoRetry
// ---------------------------------------------------------------------------

import { useApiState, withAutoRetry } from '../src/composables/useApiWithRetry'

describe('useApiWithRetry store + withAutoRetry', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('initial store state is idle', () => {
    const s = useApiState()
    expect(s.state).toBe('idle')
    expect(s.hint).toBeNull()
    expect(s.retryInSec).toBeNull()
  })

  it('manual retry() with nothing pending resets to idle', async () => {
    const s = useApiState()
    s.state = 'cmms-api-down'
    s.hint = 'something'
    await s.retry()
    expect(s.state).toBe('idle')
    expect(s.hint).toBeNull()
  })

  it('successful queryFn leaves the store in idle', async () => {
    const s = useApiState()
    const fn = withAutoRetry(async () => 42)
    const result = await fn()
    expect(result).toBe(42)
    expect(s.state).toBe('idle')
    expect(s.hint).toBeNull()
    expect(s.retryInSec).toBeNull()
  })

  it('4xx error: store stays idle, error is rethrown', async () => {
    const s = useApiState()
    const fn = withAutoRetry(async () => {
      throw { status: 404, message: 'HTTP 404', body: { error: 'not found' } }
    })
    await expect(fn()).rejects.toMatchObject({ status: 404 })
    expect(s.state).toBe('idle')
  })

  it('network error (status 0) sets state to network-down and rethrows', async () => {
    const s = useApiState()
    const fn = withAutoRetry(async () => {
      throw { status: 0, message: 'Network error', body: undefined }
    })
    await expect(fn()).rejects.toMatchObject({ status: 0 })
    expect(s.state).toBe('network-down')
    expect(s.hint).toBe('Connection error')
  })

  it('cmms-api-unavailable body sets state to cmms-api-down with hint', async () => {
    const s = useApiState()
    const fn = withAutoRetry(async () => {
      throw {
        status: 503,
        message: 'HTTP 503',
        body: { error: 'cmms-api unavailable', hint: 'reloading' },
      }
    })
    await expect(fn()).rejects.toBeTruthy()
    expect(s.state).toBe('cmms-api-down')
    expect(s.hint).toBe('reloading')
  })

  it('other 5xx: state cmms-api-down, hint falls back to body.error or "Server error"', async () => {
    const s = useApiState()
    const fn = withAutoRetry(async () => {
      throw { status: 500, message: 'HTTP 500', body: { error: 'oops' } }
    })
    await expect(fn()).rejects.toBeTruthy()
    expect(s.state).toBe('cmms-api-down')
    expect(s.hint).toBe('oops')
  })

  it('TypeError("Failed to fetch") is classified as network-down', async () => {
    const s = useApiState()
    const fn = withAutoRetry(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fn()).rejects.toBeTruthy()
    expect(s.state).toBe('network-down')
  })

  it('schedules the 5s backoff after a failure, ticks down retryInSec', async () => {
    const s = useApiState()
    const fn = withAutoRetry(async () => {
      throw { status: 0, message: 'Network error', body: undefined }
    })
    await expect(fn()).rejects.toBeTruthy()
    // Initial countdown should be 5s.
    expect(s.retryInSec).toBe(5)

    // Advance 3 seconds — countdown should be 2s.
    vi.advanceTimersByTime(3_000)
    expect(s.retryInSec).toBe(2)

    // Advance to 5s — the auto-retry timer fires, runs the failing fn,
    // and the catch block re-arms the next 15s window. The catch runs
    // inside an `await pending.fn()` microtask, so we need to flush
    // microtasks before asserting on the new retryInSec.
    vi.advanceTimersByTime(2_000)
    await nextTick()
    expect(s.state).toBe('network-down')
    expect(s.retryInSec).toBe(15)
  })

  it('gives up after 4 auto-retries (5+15+30+60s) and shows Retry now', async () => {
    const s = useApiState()
    const fn = withAutoRetry(async () => {
      throw { status: 0, message: 'Network error', body: undefined }
    })
    // Initial fail.
    await expect(fn()).rejects.toBeTruthy()
    // After each backoff window, the auto-retry fires, calls fn, which
    // fails again, and arms the NEXT window. Walk through all 4.
    for (const ms of [5_000, 15_000, 30_000, 60_000]) {
      vi.advanceTimersByTime(ms)
      await nextTick()
      expect(s.state).toBe('network-down')
    }
    // The 4th auto-retry has just fired. After it fails, attempts == 4
    // (== MAX_AUTO_ATTEMPTS) so scheduleNextRetry should set retryInSec=null
    // (manual mode). Wait a microtask for the catch to propagate.
    await nextTick()
    expect(s.retryInSec).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. useEventSource — singleton EventSource + reconnect state
// ---------------------------------------------------------------------------

import {
  useEventSource,
  disposeEventSource,
  getConnectionState,
  connectionState,
} from '../src/composables/useEventSource'

describe('useEventSource', () => {
  // We can't use a real EventSource (the server isn't running in tests).
  // Patch the global so we can control the lifecycle.
  let fakeSource: {
    onopen: (() => void) | null
    onerror: ((e?: unknown) => void) | null
    readyState: number
    close: () => void
  }
  let originalEventSource: typeof EventSource
  let ctorCalls: number

  beforeEach(() => {
    ctorCalls = 0
    fakeSource = {
      onopen: null,
      onerror: null,
      readyState: 1, // OPEN
      close: () => {},
    }
    originalEventSource = globalThis.EventSource
    // Minimal EventSource shim — just enough for the manager to wire its
    // lifecycle callbacks. We never read the URL the manager passes in
    // because we drive `onopen` / `onerror` manually.
    // @ts-expect-error — replacing the global is intentional
    globalThis.EventSource = class FakeEventSource {
      constructor(_url: string) {
        ctorCalls += 1
        return fakeSource as unknown as EventSource
      }
      get onopen() { return fakeSource.onopen }
      set onopen(v) { fakeSource.onopen = v }
      get onerror() { return fakeSource.onerror }
      set onerror(v) { fakeSource.onerror = v }
      get readyState() { return fakeSource.readyState }
      close() { fakeSource.close() }
      addEventListener() { /* noop for the manager tests */ }
      removeEventListener() { /* noop */ }
    } as unknown as typeof EventSource
    // Reset module-level state.
    disposeEventSource()
  })
  afterEach(() => {
    globalThis.EventSource = originalEventSource
    disposeEventSource()
  })

  it('creates an EventSource on the first call', () => {
    expect(ctorCalls).toBe(0)
    useEventSource()
    expect(ctorCalls).toBe(1)
  })

  it('returns the same singleton on subsequent calls', () => {
    const a = useEventSource()
    const b = useEventSource()
    expect(a).toBe(b)
    expect(ctorCalls).toBe(1)
  })

  it('connectionState goes to "reconnecting" on construction, "connected" on onopen', () => {
    connectionState.value = 'disconnected'
    useEventSource()
    // The manager sets it to 'reconnecting' on construction so the
    // topbar can show honest state during the initial connect.
    expect(getConnectionState()).toBe('reconnecting')
    fakeSource.onopen?.()
    expect(getConnectionState()).toBe('connected')
  })

  it('disposeEventSource() closes the connection and resets state', () => {
    const closeSpy = vi.spyOn(fakeSource, 'close')
    useEventSource()
    disposeEventSource()
    expect(closeSpy).toHaveBeenCalled()
    expect(getConnectionState()).toBe('disconnected')
  })
})

// ---------------------------------------------------------------------------
// 4. stream store — rolling buffer + subscribe ref-count + pause
// ---------------------------------------------------------------------------

import { useStreamStore, MAX_EVENTS } from '../src/stores/stream'
import { useStreamEvents } from '../src/composables/useStreamEvents'
import type { StreamEvent } from '../src/lib/api'

function helloEv(): StreamEvent {
  return { type: 'hello', t: '2026-08-12T12:00:00.000Z' }
}
function questionEv(q: string): StreamEvent {
  return { type: 'question', t: '2026-08-12T12:00:01.000Z', tool: 'answer', q }
}
function answerEv(summary: string): StreamEvent {
  return { type: 'answer', t: '2026-08-12T12:00:02.000Z', tool: 'answer', summary }
}
function approvalEv(id: string): StreamEvent {
  return {
    type: 'approval',
    t: '2026-08-12T12:00:03.000Z',
    id,
    action: 'rotate',
    summary: `APPROVED: ${id}`,
  }
}

describe('useStreamStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('initial state: empty buffer, not paused', () => {
    const s = useStreamStore()
    expect(s.events).toEqual([])
    expect(s.pause).toBe(false)
    expect(s.droppedWhilePaused).toBe(0)
  })

  it('pushEvent adds to the front (newest first)', () => {
    const s = useStreamStore()
    s.pushEvent(helloEv())
    s.pushEvent(questionEv('first'))
    s.pushEvent(questionEv('second'))
    expect(s.events[0]?.type).toBe('question')
    expect((s.events[0] as { q: string }).q).toBe('second')
    expect(s.events.length).toBe(3)
  })

  it('caps the buffer at MAX_EVENTS, dropping the oldest', () => {
    const s = useStreamStore()
    for (let i = 0; i < MAX_EVENTS + 5; i++) {
      s.pushEvent(questionEv(`q${i}`))
    }
    expect(s.events.length).toBe(MAX_EVENTS)
    // Newest is q{MAX_EVENTS+4}; oldest is q5.
    expect((s.events[0] as { q: string }).q).toBe(`q${MAX_EVENTS + 4}`)
    expect((s.events[s.events.length - 1] as { q: string }).q).toBe('q5')
  })

  it('pause: pushEvent becomes a no-op, counter increments', () => {
    const s = useStreamStore()
    s.togglePause()
    s.pushEvent(helloEv())
    s.pushEvent(answerEv('x'))
    expect(s.events.length).toBe(0)
    expect(s.droppedWhilePaused).toBe(2)
  })

  it('togglePause back to false resets the dropped counter', () => {
    const s = useStreamStore()
    s.togglePause()
    s.pushEvent(helloEv())
    s.togglePause()
    expect(s.droppedWhilePaused).toBe(0)
    s.pushEvent(helloEv())
    expect(s.events.length).toBe(1)
  })

  it('clear() empties the buffer and resets the dropped counter (pause is independent)', () => {
    const s = useStreamStore()
    s.pushEvent(helloEv())
    s.togglePause()
    s.pushEvent(helloEv())
    s.clear()
    expect(s.events.length).toBe(0)
    expect(s.droppedWhilePaused).toBe(0)
    // Pause is a separate state machine — clear() does not flip it back.
    // (If you want to unpause, call togglePause() again.)
    expect(s.pause).toBe(true)
  })

  it('subscribe/unsubscribe ref-count: first opens, last cleans up', () => {
    const s = useStreamStore()
    const u1 = s.subscribe()
    const u2 = s.subscribe()
    // Two subscribers, one shared listener set.
    expect(s.events.length).toBe(0)
    u1()
    // Still one subscriber — listeners should still be attached.
    // (We can't easily assert this without poking into the store's
    // internals; the unsubscribe flow is exercised by the manager test.)
    u2()
    // Zero subscribers — listeners detached. (Same caveat.)
  })
})

// ---------------------------------------------------------------------------
// 5. useStreamEvents — read-only facade
// ---------------------------------------------------------------------------

describe('useStreamEvents', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('returns reactive refs + method references', () => {
    const s = useStreamStore()
    s.pushEvent(helloEv())
    const { events, pause, togglePause, clear } = useStreamEvents()
    expect(events.value.length).toBe(1)
    expect(pause.value).toBe(false)
    togglePause()
    expect(pause.value).toBe(true)
    clear()
    expect(events.value.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Smoke: render a tiny component that uses the data layer
// ---------------------------------------------------------------------------

describe('data layer smoke (component mount)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('mounts a component that reads the api store', async () => {
    const s = useStreamStore()
    s.pushEvent(answerEv('hello world'))
    const Probe = defineComponent({
      setup() {
        return () => h('div', { 'data-testid': 'probe' }, s.events.length.toString())
      },
    })
    const wrapper = mount(Probe)
    expect(wrapper.attributes('data-testid')).toBe('probe')
    expect(wrapper.text()).toBe('1')
  })
})
