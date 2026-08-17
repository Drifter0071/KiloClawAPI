// src/composables/useEventSource.ts
//
// Module-scoped, single-instance EventSource manager for the dashboard.
//
// One `EventSource` per browser tab. The connection is opened lazily on the
// first call to `useEventSource()` and lives until `disposeEventSource()` is
// called (or the page unloads). On transport errors the manager schedules a
// reconnect with the same 5/15/30/60s backoff used by `useApiWithRetry` —
// tracked here independently so the two timers don't fight.
//
// This module exports:
//   - useEventSource()         — returns the current EventSource (creates it
//                                on first call). Subsequent calls return the
//                                same instance.
//   - disposeEventSource()     — closes the connection cleanly. Used by tests
//                                and by HMR teardown.
//   - getConnectionState()     — 'connected' | 'reconnecting' | 'disconnected'.
//                                Read by the shell's ConnectionStatus chip.
//
// `api.stream()` (in useApi.ts) is the underlying factory — it returns a raw
// `new EventSource(...)`. We wrap it here so the rest of the app talks to
// one stable instance via `addEventListener('hello' | 'question' | …)`.
//
// No Vue reactivity is exposed for the EventSource itself (it already
// fires DOM events). The only reactive thing in this module is
// `connectionState`, a module-level ref consumed by ConnectionStatus.

import { ref, type Ref } from 'vue'
import { useApi } from './useApi'
import type { StreamEvent } from '@/lib/api'

// ---------------------------------------------------------------------------
// Module-level state — one EventSource per browser tab.
// ---------------------------------------------------------------------------

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000] as const
const MAX_AUTO_ATTEMPTS = BACKOFF_MS.length // 4

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected'

/**
 * Reactive connection state for the topbar's ConnectionStatus chip.
 * Updated by the `onopen` / `onerror` handlers below.
 */
export const connectionState: Ref<ConnectionState> = ref('disconnected')

/** The single shared EventSource. Null until the first useEventSource() call. */
let source: EventSource | null = null

/** Current backoff attempt counter (reset on a successful `onopen`). */
let reconnectAttempts = 0

/** Pending reconnect timer handle. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  clearReconnectTimer()
  if (reconnectAttempts >= MAX_AUTO_ATTEMPTS) {
    // Out of automatic retries — leave the state at 'reconnecting' so the
    // shell can show "Stream disconnected — retrying in the background"
    // (per spec §5.2). The user can reload the page to start over.
    return
  }
  const delay = BACKOFF_MS[reconnectAttempts]!
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openSource()
  }, delay)
}

function attachLifecycle(es: EventSource) {
  es.onopen = () => {
    // Native EventSource reconnects itself on transient disconnects — when
    // that succeeds, the open event fires again. Reset our backoff so the
    // NEXT genuine error starts fresh from 5s.
    reconnectAttempts = 0
    connectionState.value = 'connected'
  }
  es.onerror = () => {
    // The native EventSource fires `onerror` for every transient drop,
    // even while it's auto-reconnecting (default browser backoff is ~3s).
    // We must NOT close + re-open in that case — we'd fight the browser's
    // own reconnection and risk creating two live connections.
    //
    // The distinguisher is `readyState`:
    //   0 = CONNECTING  → browser is already trying to recover, just
    //                     reflect the 'reconnecting' UI state and back off
    //                     our counter so a successful `onopen` resets it.
    //   2 = CLOSED      → browser has given up; we layer our own 5/15/30/60s
    //                     backoff on top, closing the dead handle and
    //                     re-opening via `scheduleReconnect()`.
    connectionState.value = 'reconnecting'
    if (es.readyState === EventSource.CLOSED) {
      reconnectAttempts += 1
      if (source === es) {
        source = null
      }
      scheduleReconnect()
    }
    // readyState === EventSource.CONNECTING → the browser is doing its
    // own retry; do nothing else. Our next `onopen` will reset the state.
  }
}

function openSource(): EventSource {
  // Always create a fresh handle — `new EventSource(url)` will reconnect
  // internally, but the per-handle listener set we use elsewhere is fixed
  // at construction time, so re-using a handle after a re-attach is brittle.
  // Open a new one and let the consumer re-subscribe via the store.
  const es = useApi().stream()
  source = es
  attachLifecycle(es)
  // Mark reconnecting while we wait for the server's `onopen` to confirm.
  // If this is a cold open, the page will briefly show "reconnecting" until
  // onopen flips us back to 'connected' (typically < 100ms on localhost).
  // The browser will fire onerror within seconds if the server is down,
  // which keeps the state at 'reconnecting' honestly.
  if (connectionState.value !== 'reconnecting') {
    connectionState.value = 'reconnecting'
  }
  return es
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the single shared `EventSource` for `/dashboard/api/stream`.
 * Created on the first call; every subsequent call returns the same
 * instance until `disposeEventSource()` is invoked.
 *
 * Consumers attach named event listeners (`'hello'`, `'question'`,
 * `'answer'`, `'approval'`) directly. The store in `stores/stream.ts`
 * owns those listeners; pages just read the rolling event buffer.
 */
export function useEventSource(): EventSource {
  if (source === null) {
    return openSource()
  }
  return source
}

/**
 * Close the shared EventSource and reset all module state. Used by tests
 * and by HMR teardown so a hot-reloaded module starts from a clean slate.
 */
export function disposeEventSource(): void {
  clearReconnectTimer()
  if (source !== null) {
    try {
      source.close()
    } catch {
      // ignore
    }
    source = null
  }
  reconnectAttempts = 0
  connectionState.value = 'disconnected'
}

/**
 * Read the current SSE connection state for the shell's ConnectionStatus
 * chip. Reactive — components should use the exported `connectionState`
 * ref directly when they want to subscribe, or this getter for one-shot
 * reads in event handlers.
 */
export function getConnectionState(): ConnectionState {
  return connectionState.value
}

// ---------------------------------------------------------------------------
// Internal: re-export the StreamEvent type so the store can import both
// the EventSource and the event shape from a single module if it wants to.
// (Not strictly required — the store imports the type from @/lib/api — but
// kept here as a convenience for future readers.)
// ---------------------------------------------------------------------------

export type { StreamEvent }
