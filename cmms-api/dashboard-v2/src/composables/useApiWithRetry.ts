import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Phase 2 skeleton for the cmms-api-down retry banner.
 * The full SSE/timer logic lands in Phase 4; for now this just
 * exposes the state shape that `GlobalBanner.vue` consumes.
 */
export const useApiState = defineStore('api-state', () => {
  const state = ref<'idle' | 'cmms-api-down' | 'network-down'>('idle')
  const hint = ref<string | null>(null)
  const retryInSec = ref<number | null>(null)
  function retry() {
    // no-op in Phase 2; Phase 4 wires the timer + backoff (5/15/30/60s).
  }
  return { state, hint, retryInSec, retry }
})
