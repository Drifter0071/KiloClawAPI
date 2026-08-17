// src/composables/useStreamEvents.ts
//
// Read-only composable that exposes the stream store's reactive surface
// to pages (and other components). The actual state lives in
// `stores/stream.ts`; this file just unpacks the bits consumers need.
//
// Signature (per the P4.4 brief):
//
//   useStreamEvents(): {
//     events:       Ref<StreamEvent[]>   // rolling 100, newest first
//     pause:        Ref<boolean>         // true → pushEvent is a no-op
//     togglePause:  () => void           // flip pause
//     clear:        () => void           // empty the buffer
//   }
//
// Usage from a page's `<script setup>`:
//
//   const { events, pause, togglePause, clear } = useStreamEvents()
//   onMounted(() => {
//     const unsubscribe = useStreamStore().subscribe()
//     onScopeDispose(() => unsubscribe())
//   })
//
// We intentionally do NOT call `subscribe()` inside this composable:
// that would couple read-only consumers (e.g. the Ask page showing
// "live: 3 events") to the EventSource connection lifecycle. The page
// that actually wants to render the event list (StreamPage) is the one
// that should call `subscribe()` — usually inside `onMounted` with the
// matching `onScopeDispose(() => unsubscribe())`.

import { storeToRefs } from 'pinia'
import type { Ref } from 'vue'
import { useStreamStore } from '@/stores/stream'
import type { StreamEvent } from '@/lib/api'

export interface UseStreamEventsResult {
  events: Ref<StreamEvent[]>
  pause: Ref<boolean>
  togglePause: () => void
  clear: () => void
}

export function useStreamEvents(): UseStreamEventsResult {
  const store = useStreamStore()
  // `storeToRefs` preserves reactivity for `events` and `pause` (refs in
  // the setup store). Methods are passed through directly — they're
  // already stable function references on the store instance.
  const { events, pause } = storeToRefs(store)
  return {
    events,
    pause,
    togglePause: store.togglePause,
    clear: store.clear,
  }
}
