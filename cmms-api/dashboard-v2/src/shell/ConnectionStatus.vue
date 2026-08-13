<script setup lang="ts">
// Phase 2 skeleton: state is hardcoded to 'connected'. Phase 4 wires real SSE state.
const state: 'connected' = 'connected'
const LABEL: Record<typeof state, string> = {
  connected: 'Élő',
}
</script>

<template>
  <div
    class="h-7 px-2.5 rounded-full bg-surface border border-border-subtle text-xs font-mono flex items-center gap-2"
    role="status"
    :aria-label="`Kapcsolat: ${LABEL[state]}`"
  >
    <span
      class="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
      aria-hidden="true"
    ></span>
    <span class="text-text-secondary">{{ LABEL[state] }}</span>
  </div>
</template>
