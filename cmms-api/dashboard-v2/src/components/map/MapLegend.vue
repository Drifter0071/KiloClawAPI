<script setup lang="ts">
// src/components/map/MapLegend.vue
//
// Compact floating legend for the Spatial Map page (top-left).
//
// Shows the visual key for the cytoscape graph:
//   - A row of three sample circles in the NCT purple accent, scaled
//     to roughly match the node-size curve (small / medium / large).
//   - A short caption: "Csomópont méret = ticket szám".
//
// `maxTickets` is used to label the largest circle so the user
// can mentally map "this big dot = ~N tickets".

import { computed } from 'vue'

const props = defineProps<{
  /** Largest ticket count in the current dataset (drives the legend's
   *  top end so the user sees the actual scale, not a generic value). */
  maxTickets: number
}>()

// Pick three sample values that span the visible size range.
// `1` is the minimum, `maxTickets` is the maximum, and the middle
// is the geometric mean so the swatches look evenly spaced on a
// log scale (which is closer to how the eye reads area).
const small = 1
const medium = computed(() => {
  const m = props.maxTickets || 1
  return Math.max(2, Math.round(Math.sqrt(m)))
})
const large = computed(() => Math.max(1, props.maxTickets || 1))

// Map the same size curve as the cytoscape graph (see lib/cytoscape.ts
// `nodeSize`). We need this to look right at any zoom level, so we
// clamp the visual diameter to a reasonable range.
function visualSize(tickets: number): number {
  const t = Math.max(0, Number(tickets) || 0)
  const raw = 14 + Math.sqrt(t) * 4.2
  // Smaller clamping than the on-canvas node so the legend swatches
  // fit the card. 10..32 is the sweet spot for a 240px-wide legend.
  return Math.min(32, Math.max(10, Math.round(raw / 3)))
}
</script>

<template>
  <div
    class="rounded-lg border border-border-subtle bg-canvas-2/90 backdrop-blur-sm shadow-md p-3 text-text-secondary"
    data-testid="map-legend"
  >
    <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-2">
      Jelmagyarázat
    </div>
    <div class="flex items-end gap-4" data-testid="map-legend-row">
      <!-- Small -->
      <div class="flex flex-col items-center gap-1">
        <span
          class="rounded-full bg-nct-soft shadow-sm"
          :style="{ width: visualSize(small) + 'px', height: visualSize(small) + 'px' }"
          aria-hidden="true"
        />
        <span class="text-[10px] text-text-muted font-mono">{{ small }}</span>
      </div>
      <!-- Medium -->
      <div class="flex flex-col items-center gap-1">
        <span
          class="rounded-full bg-nct-soft shadow-sm"
          :style="{ width: visualSize(medium) + 'px', height: visualSize(medium) + 'px' }"
          aria-hidden="true"
        />
        <span class="text-[10px] text-text-muted font-mono">{{ medium }}</span>
      </div>
      <!-- Large -->
      <div class="flex flex-col items-center gap-1">
        <span
          class="rounded-full bg-nct-soft shadow-sm"
          :style="{ width: visualSize(large) + 'px', height: visualSize(large) + 'px' }"
          aria-hidden="true"
        />
        <span class="text-[10px] text-text-muted font-mono">{{ large }}+</span>
      </div>
    </div>
    <div class="text-[11px] text-text-secondary mt-2 leading-snug">
      Csomópont méret = ticket szám
    </div>
  </div>
</template>
