// src/stores/stream.ts
//
// Pinia store for the live SSE event log shown on the Live Stream page
// (and read-only elsewhere via `useStreamEvents`).
//
// Shape (per spec §2.1, §5.2, §6.6):
//   - `events: Ref<StreamEvent[]>`   rolling 100 most recent events, newest first
//   - `pause:  Ref<boolean>`         when true, `pushEvent` is a no-op
//   - `pushEvent(ev)`                pushes to the front and trims to 100
//   - `clear()`                      empties the list
//   - `togglePause()`                flips the pause flag
//   - `subscribe()` / `unsubscribe()`  ref-counted; the underlying EventSource
//                                     is attached on the first subscribe and
//                                     detached on the last unsubscribe so the
//                                     SSE connection doesn't open until the
//                                     Live Stream page mounts.
//
// Pause semantics (per spec §5.2 "Clicking `Pause` freezes the stream."):
//   - When paused, the EventSource stays connected so reconnects still work
//     and we don't lose the live source — we just stop appending to the
//     buffer. The store keeps counting (in `droppedWhilePaused`) for
//     diagnostic / status display, but the consumer-visible list is frozen.
//   - When unpaused, the buffer does NOT replay missed events — SSE has no
//     "give me what I missed" mode and the spec accepts this. The counter
//     resets to 0 on unpause.
//
// Why a Pinia store and not a composable with module-level refs?
//   Pinia gives us devtools visibility into the buffer length, the pause
//   flag, and the subscriber count — useful when the page's "Live · N
//   events" counter misbehaves. The composable layer (`useStreamEvents`)
//   keeps the call site clean.

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useEventSource, disposeEventSource } from '@/composables/useEventSource'
import type { StreamEvent } from '@/lib/api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on the rolling event buffer (per spec §5.2 / §6.6). */
export const MAX_EVENTS = 100

/** Named SSE event types emitted by /dashboard/api/stream (server.ts:493). */
const NAMED_EVENT_TYPES = ['hello', 'question', 'answer', 'approval'] as const

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useStreamStore = defineStore('stream', () => {
  /** Rolling buffer of recent events, newest first. Capped at MAX_EVENTS. */
  const events = ref<StreamEvent[]>([])

  /** When true, `pushEvent` is a no-op so the page's Pause button works. */
  const pause = ref<boolean>(false)

  /**
   * Count of events that arrived while paused and were dropped. Surfaced
   * for the diagnostic banner ("Paused — 12 events dropped") and reset
   * on unpause. Not reactive in the spec's required surface, but exposing
   * it on the store costs nothing.
   */
  const droppedWhilePaused = ref<number>(0)

  /**
   * Number of active `subscribe()` callers. When this goes 0 → 1 we
   * attach our listeners to the EventSource; when it goes 1 → 0 we
   * detach them. (We never close the EventSource itself — it's a
   * singleton with its own reconnect logic, and other tabs might be
   * relying on the same lifecycle if HMR reuses the module.)
   */
  let subscribers = 0
  /** Set of named-event-type handlers we attached, so we can detach cleanly. */
  const handlerRefs = new Map<string, (ev: MessageEvent) => void>()

  // -------------------------------------------------------------------------
  // Mutators
  // -------------------------------------------------------------------------

  function pushEvent(ev: StreamEvent): void {
    if (pause.value) {
      droppedWhilePaused.value += 1
      return
    }
    // Push to the front, trim to MAX_EVENTS. `unshift` is O(n) but n ≤ 100.
    events.value.unshift(ev)
    if (events.value.length > MAX_EVENTS) {
      events.value.length = MAX_EVENTS
    }
  }

  function clear(): void {
    events.value = []
    droppedWhilePaused.value = 0
  }

  function togglePause(): void {
    pause.value = !pause.value
    if (!pause.value) {
      // Reset the counter on unpause — the dropped events are gone for good
      // (SSE has no replay), and the count is only useful as a "you missed N
      // things" hint that should not persist across pause cycles.
      droppedWhilePaused.value = 0
    }
  }

  // -------------------------------------------------------------------------
  // EventSource subscription lifecycle
  // -------------------------------------------------------------------------

  /**
   * Attach a `message` / named-event listener to the shared EventSource and
   * route every event into `pushEvent`. Idempotent across multiple
   * subscribers — the same single set of listeners is shared.
   *
   * Returns an `unsubscribe` function. The first caller triggers the
   * EventSource open (via `useEventSource()`); the last caller detaches
   * the listeners. The connection itself is not closed on the last
   * unsubscribe — that would defeat the "one per tab" singleton
   * property and force the next subscriber to wait for the SSE
   * reconnect. Instead, we just stop listening; the next `subscribe()`
   * reattaches without dropping the connection.
   */
  function subscribe(): () => void {
    subscribers += 1
    if (subscribers === 1) {
      const es = useEventSource()
      for (const type of NAMED_EVENT_TYPES) {
        // Each handler parses the JSON `data` field. The server always
        // sends a single `data:` line whose payload is the full
        // `StreamEvent` object (see server.ts:493). Malformed payloads
        // are dropped silently — we don't want a single bad event to
        // kill the buffer.
        const handler = (msg: MessageEvent) => {
          try {
            const ev = JSON.parse(msg.data) as StreamEvent
            pushEvent(ev)
          } catch {
            // ignore — keep the buffer healthy
          }
        }
        es.addEventListener(type, handler as EventListener)
        handlerRefs.set(type, handler)
      }
    }
    return () => {
      subscribers = Math.max(0, subscribers - 1)
      if (subscribers === 0 && handlerRefs.size > 0) {
        // Detach, but don't close the EventSource. We don't have a stable
        // reference here, so look it up via useEventSource() — that
        // returns the same singleton as long as disposeEventSource()
        // hasn't been called.
        const es = useEventSource()
        for (const [type, handler] of handlerRefs) {
          es.removeEventListener(type, handler as EventListener)
        }
        handlerRefs.clear()
      }
    }
  }

  // Exposed for tests / HMR — never called by app code in production.
  function _teardownForTesting(): void {
    subscribers = 0
    handlerRefs.clear()
    clear()
    pause.value = false
    disposeEventSource()
  }

  return {
    // State
    events,
    pause,
    droppedWhilePaused,
    // Mutators
    pushEvent,
    clear,
    togglePause,
    // Lifecycle
    subscribe,
    _teardownForTesting,
  }
})
