<script setup lang="ts">
import { useApiState } from '@/composables/useApiWithRetry'
import { storeToRefs } from 'pinia'

// The Pinia store lives inside the `useApiWithRetry` composable (see
// `src/composables/useApiWithRetry.ts`). In Phase 2 the store is a
// skeleton: state is always 'idle', so the banner never renders. Phase 4
// wires the real timer and the cmms-api / network error detection.
const api = useApiState()
// `storeToRefs` only converts state/getters; methods stay on the store
// object directly. Destructure them separately.
const { state, hint, retryInSec } = storeToRefs(api)
const { retry } = api
</script>

<template>
  <div
    v-if="state !== 'idle'"
    role="status"
    aria-live="polite"
    class="h-9 px-6 bg-warning/[0.08] border-b border-warning/20 text-warning text-xs flex items-center gap-3 shrink-0"
  >
    <span aria-hidden="true">⚠</span>
    <span class="flex-1">{{ hint }}</span>
    <span
      v-if="retryInSec !== null"
      class="font-mono text-text-muted"
      >Retrying in {{ retryInSec }}s…</span
    >
    <button
      v-if="retryInSec === null"
      type="button"
      class="text-text-primary hover:text-accent transition-colors duration-150"
      @click="retry"
    >
      Retry now
    </button>
  </div>
</template>
