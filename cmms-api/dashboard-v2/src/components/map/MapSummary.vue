<script setup lang="ts">
// src/components/map/MapSummary.vue
//
// Compact stats card pinned to the bottom-left of the Map page.
// Shows the four numbers the operator needs to read at a glance:
//   - visible nodes (after search filter)
//   - total ticket count in the visible set
//   - visible family groups
//   - dropped nodes (the placeholder / status-word rows that the
//     normalization layer filtered out — "N rejtett")
//
// When a search is active and matches nothing, the card flips to a
// "no results" state with a "clear search" CTA so the user can
// recover without hunting for the search input in the toolbar.

import { computed } from 'vue'

const props = defineProps<{
  visibleNodesCount: number
  totalTickets: number
  visibleGroupsCount: number
  droppedCount: number
  droppedTotalTickets: number
  searchQuery: string
}>()

const emit = defineEmits<{
  (e: 'clear-search'): void
}>()

const isEmptyResult = computed(
  () => props.searchQuery.trim() !== '' && props.visibleNodesCount === 0,
)

function fmt(n: number): string {
  return n.toLocaleString('hu-HU')
}
</script>

<template>
  <div
    class="rounded-lg border border-border-subtle bg-canvas-2/90 backdrop-blur-sm shadow-md px-3.5 py-2.5 min-w-[200px]"
    data-testid="map-summary"
  >
    <div
      class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5"
    >
      Áttekintés
    </div>
    <dl class="grid grid-cols-3 gap-x-3 gap-y-1.5 text-[11px]">
      <div class="flex flex-col">
        <dt class="text-text-muted">Csomópont</dt>
        <dd
          class="font-mono text-text-primary tabular-nums text-[13px] font-semibold"
          data-testid="map-summary-nodes"
        >
          {{ fmt(visibleNodesCount) }}
        </dd>
      </div>
      <div class="flex flex-col">
        <dt class="text-text-muted">Ticket</dt>
        <dd
          class="font-mono text-text-primary tabular-nums text-[13px] font-semibold"
          data-testid="map-summary-tickets"
        >
          {{ fmt(totalTickets) }}
        </dd>
      </div>
      <div class="flex flex-col">
        <dt class="text-text-muted">Család</dt>
        <dd
          class="font-mono text-text-primary tabular-nums text-[13px] font-semibold"
          data-testid="map-summary-groups"
        >
          {{ fmt(visibleGroupsCount) }}
        </dd>
      </div>
    </dl>

    <div
      v-if="droppedCount > 0"
      class="mt-2 pt-2 border-t border-border-subtle text-[10px] text-text-muted font-mono"
      data-testid="map-summary-dropped"
    >
      <span class="text-text-secondary">{{ fmt(droppedCount) }} rejtett</span>
      <span aria-hidden="true">·</span>
      <span class="tabular-nums">{{ fmt(droppedTotalTickets) }} ticket</span>
    </div>

    <div
      v-if="isEmptyResult"
      class="mt-2 pt-2 border-t border-border-subtle"
    >
      <p class="text-[11px] text-text-muted mb-1.5">
        Nincs találat a „{{ searchQuery }}" keresésre.
      </p>
      <button
        type="button"
        class="w-full text-left text-[11px] text-accent hover:text-accent-hover transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
        data-testid="map-summary-clear"
        @click="emit('clear-search')"
      >
        Keresés törlése →
      </button>
    </div>
  </div>
</template>
