<script setup lang="ts">
// src/shell/GlobalBanner.vue
//
// Warning strip rendered directly under the topbar (Phase 7).
//
// Shown when the cmms-api is unavailable or the network is down
// (see composables/useApiWithRetry.ts for state machine). Provides a
// one-tap "retry now" action and a countdown when the auto-retry
// is in flight.

import { useApiState } from '@/composables/useApiWithRetry'
import { storeToRefs } from 'pinia'

const api = useApiState()
const { state, hint, retryInSec } = storeToRefs(api)
const { retry } = api
</script>

<template>
  <div
    v-if="state !== 'idle'"
    role="status"
    aria-live="polite"
    class="h-9 px-4 bg-warning/[0.10] border-b border-warning/25 text-warning text-xs flex items-center gap-3 shrink-0"
    data-testid="global-banner"
  >
    <svg
      class="w-3.5 h-3.5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <span class="flex-1 truncate">{{ hint }}</span>
    <span
      v-if="retryInSec !== null"
      class="font-mono text-text-muted tabular-nums"
      data-testid="banner-countdown"
    >
      {{ retryInSec }} mp
    </span>
    <button
      v-if="retryInSec === null"
      type="button"
      class="text-text-primary hover:text-accent transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
      data-testid="banner-retry"
      @click="retry"
    >
      Most próbáld újra
    </button>
  </div>
</template>
