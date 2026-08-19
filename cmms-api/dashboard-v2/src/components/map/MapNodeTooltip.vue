<script setup lang="ts">
// src/components/map/MapNodeTooltip.vue
//
// Floating tooltip that follows the cursor while a node is hovered
// on the cytoscape graph. Lightweight, no backdrop, no animation
// delay — the cytoscape `mousemove` event fires at the OS pointer
// rate, so a transition would only make the tooltip feel laggy.
//
// Shows: machine name (full label), family key, ticket count.

import type { NormalizedMapNode } from '@/lib/mapNormalization'

defineProps<{
  node: NormalizedMapNode
  /** Client-space coordinates (evt.clientX / evt.clientY from the
   *  cytoscape mousemove event). */
  x: number
  y: number
}>()
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed z-40 px-2.5 py-1.5 rounded-md border border-border-default bg-canvas-2/95 backdrop-blur-sm shadow-md text-xs"
      :style="{ left: x + 'px', top: y + 'px' }"
      data-testid="map-tooltip"
    >
      <div class="flex items-center gap-2">
        <span
          class="shrink-0 rounded-full"
          :style="{
            width: '8px',
            height: '8px',
            backgroundColor: node.color,
          }"
          aria-hidden="true"
        />
        <span class="font-mono text-[12px] font-semibold text-text-primary truncate max-w-[240px]" :title="node.label">
          {{ node.label }}
        </span>
      </div>
      <div class="mt-0.5 flex items-center gap-2 text-[10px] text-text-muted font-mono">
        <span>{{ node.familyLabel }}</span>
        <span aria-hidden="true">·</span>
        <span class="tabular-nums">
          {{ node.tickets.toLocaleString('hu-HU') }} ticket
        </span>
      </div>
    </div>
  </Teleport>
</template>
