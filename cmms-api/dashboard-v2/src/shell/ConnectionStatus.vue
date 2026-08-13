<script setup lang="ts">
// src/shell/ConnectionStatus.vue
//
// Compact SSE connection chip in the topbar (Phase 7).
//
// The state is a small Pinia store owned by useEventSource; we just
// render its current value. Three states, three colours, three labels.
//
// The chip is a static "label + dot" pattern (no dropdown, no click
// affordance). Tapping a static status indicator is a common HIG
// anti-pattern; if the operator needs to disconnect, the Stream page
// has an explicit Pause button.

import { computed } from 'vue'
import { connectionState } from '@/composables/useEventSource'

const state = computed(() => connectionState.value)
const isOk = computed(() => state.value === 'connected')
const isWarn = computed(() => state.value === 'reconnecting')
const isDown = computed(() => state.value === 'disconnected')

const LABEL: Record<typeof state.value, string> = {
  connected: 'Élő',
  reconnecting: 'Újracsatlakozás',
  disconnected: 'Nincs kapcsolat',
}

const dotClass = computed(() =>
  isOk.value
    ? 'bg-success'
    : isWarn.value
      ? 'bg-warning animate-pulse'
      : 'bg-danger',
)

const textClass = computed(() =>
  isOk.value ? 'text-text-secondary' : 'text-text-primary',
)
</script>

<template>
  <span
    class="h-7 px-2.5 rounded-md bg-surface/60 border border-border-subtle text-xs font-mono flex items-center gap-1.5"
    role="status"
    :aria-label="`Kapcsolat: ${LABEL[state]}`"
    data-testid="connection-status"
  >
    <span
      class="inline-block w-1.5 h-1.5 rounded-full"
      :class="dotClass"
      aria-hidden="true"
    />
    <span :class="textClass">{{ LABEL[state] }}</span>
  </span>
</template>
