<script setup lang="ts">
// src/routes/MapPage.vue
//
// HIG-flavoured Spatial Map (Phase 7).
//
// Layout:
//   - Page header (52px): title + subtitle on the left, period
//     SegmentedControl + refresh icon-button on the right. No floating
//     pills.
//   - Canvas: cytoscape host over a 24px grid background.
//   - Errors render as a centred native-OS-alert pattern (icon + bold
//     title + muted description + Újra button).
//   - Hover tooltip + node-tap side sheet unchanged from the previous
//     version — they already match HIG patterns.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { Core } from 'cytoscape'
import Button from '@/components/Button.vue'
import Drawer from '@/components/Drawer.vue'
import EmptyState from '@/components/EmptyState.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { setSeedQ } from '@/composables/useSeedQ'
import { makeCyto, nodeSize } from '@/lib/cytoscape'
import { humanizeError } from '@/lib/errors'
import type { MapNode } from '@/lib/api'

const PERIOD_OPTIONS = [
  { value: 'this_month', label: 'Ebben a hónapban' },
  { value: 'last_30_days', label: 'Utolsó 30 nap' },
  { value: 'last_year', label: 'Tavaly' },
  { value: 'all', label: 'Mind' },
]

const period = ref('this_month')

const query = useQuery({
  queryKey: ['map', period],
  queryFn: withAutoRetry(() => useApi().map(period.value)),
})

const nodes = computed(() => query.data.value?.nodes ?? [])
const humanized = computed(() =>
  query.error.value ? humanizeError(query.error.value) : null,
)

/** Sum of all tickets across the visible groups — used in the
 *  bottom-left stats badge so the user can see the total at a glance. */
const totalTickets = computed(() =>
  nodes.value.reduce((acc, n) => acc + (n.tickets ?? 0), 0),
)

/** Tiny / medium / large node diameters for the legend swatches. */
const nodeSizePx = computed(() => ({
  min: nodeSize(1),
  mid: nodeSize(20),
  max: Math.min(nodeSize(500), 40),
}))

// ---------------------------------------------------------------------------
// Cytoscape lifecycle
// ---------------------------------------------------------------------------

const canvasEl = ref<HTMLElement | null>(null)
let cy: Core | null = null

function renderGraph() {
  cy?.destroy()
  cy = null
  if (!canvasEl.value || nodes.value.length === 0) return
  cy = makeCyto(
    canvasEl.value,
    nodes.value,
    (n) => {
      selectedNode.value = n
    },
    (n: MapNode & { _color?: string; _hue?: number }, evt: MouseEvent) => {
      showTooltip(n, evt.clientX, evt.clientY)
    },
  )
}

const selectedNode = ref<(MapNode & { _color?: string; _hue?: number }) | null>(null)

watch(
  () => query.data.value,
  () => {
    selectedNode.value = null
    nextTick(renderGraph)
  },
)

onMounted(renderGraph)

onBeforeUnmount(() => {
  cy?.destroy()
  cy = null
})

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

const tooltip = ref<{ x: number; y: number; node: MapNode & { _color?: string; _hue?: number } } | null>(null)

function onMouseMove(evt: MouseEvent) {
  if (tooltip.value) {
    tooltip.value.x = evt.clientX + 14
    tooltip.value.y = evt.clientY + 14
  }
}

function onMouseLeave() {
  tooltip.value = null
}

function showTooltip(node: MapNode & { _color?: string; _hue?: number }, x: number, y: number) {
  tooltip.value = { x: x + 14, y: y + 14, node }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function viewAllInAsk(node: MapNode & { _color?: string; _hue?: number }) {
  setSeedQ(node.model || node.raw)
}

function broadenRange() {
  period.value = 'all'
}
</script>

<template>
  <div class="h-full flex flex-col" data-testid="map-page">
    <!-- Page header — HIG-flavoured, 52px, no floating pills -->
    <header
      class="h-13 px-4 md:px-6 flex items-center justify-between gap-4 border-b border-border-subtle bg-canvas-2/60 shrink-0"
    >
      <div class="min-w-0">
        <h1 class="text-[15px] font-semibold tracking-tight text-text-primary leading-none">
          Géptípus-térkép
        </h1>
        <p class="text-[12px] text-text-muted mt-1 truncate">
          Géptípusonkénti ticket-mennyiség · csomópont méret = ticket szám
        </p>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <SegmentedControl
          v-model="period"
          :options="PERIOD_OPTIONS"
          aria-label="Térkép időszaka"
          data-testid="map-period"
        />
        <button
          type="button"
          class="w-9 h-9 rounded-md border border-border-default bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center justify-center"
          :aria-label="query.isFetching.value ? 'Frissítés…' : 'Frissítés'"
          data-testid="map-refresh"
          @click="query.refetch()"
        >
          <svg
            class="w-4 h-4"
            :class="{ 'animate-spin': query.isFetching.value }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
      </div>
    </header>

    <!-- Canvas -->
    <div
      class="flex-1 relative overflow-hidden bg-surface"
      data-testid="map-canvas"
      @mousemove="onMouseMove"
      @mouseleave="onMouseLeave"
    >
      <div
        class="absolute inset-0"
        :style="{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }"
      />

      <div ref="canvasEl" class="absolute inset-0" data-testid="map-cy" />

      <!-- Bottom-left stats badge: node count + total tickets.
           The user previously had no way to tell at a glance how many
           distinct machine-type groups the canvas represents. -->
      <div
        v-if="!query.isPending.value && !humanized && nodes.length > 0"
        class="absolute bottom-3 left-3 z-10 bg-canvas-2/80 backdrop-blur border border-border-default rounded-md px-3 py-1.5 text-[11px] font-mono text-text-secondary pointer-events-none"
        data-testid="map-stats"
      >
        <span class="text-text-primary">{{ nodes.length }}</span> csomópont ·
        <span class="text-text-primary">{{ totalTickets }}</span> ticket
      </div>

      <!-- Top-left legend: color = identity, size = volume. -->
      <div
        v-if="!query.isPending.value && !humanized && nodes.length > 0"
        class="absolute top-3 left-3 z-10 bg-canvas-2/80 backdrop-blur border border-border-default rounded-md px-3 py-1.5 text-[11px] text-text-muted pointer-events-none flex items-center gap-3"
        data-testid="map-legend"
      >
        <span class="flex items-center gap-1.5">
          <span
            class="inline-block w-2.5 h-2.5 rounded-full"
            :style="{ backgroundColor: `hsl(180, 70%, 62%)` }"
            aria-hidden="true"
          />
          szín = típus
        </span>
        <span class="flex items-center gap-1.5">
          <span
            class="inline-block rounded-full"
            :style="{
              width: (nodeSizePx.min) + 'px',
              height: (nodeSizePx.min) + 'px',
              backgroundColor: `hsl(60, 70%, 62%)`,
            }"
            aria-hidden="true"
          />
          <span
            class="inline-block rounded-full"
            :style="{
              width: (nodeSizePx.mid) + 'px',
              height: (nodeSizePx.mid) + 'px',
              backgroundColor: `hsl(60, 70%, 62%)`,
            }"
            aria-hidden="true"
          />
          <span
            class="inline-block rounded-full"
            :style="{
              width: (nodeSizePx.max) + 'px',
              height: (nodeSizePx.max) + 'px',
              backgroundColor: `hsl(60, 70%, 62%)`,
            }"
            aria-hidden="true"
          />
          méret = ticket
        </span>
      </div>

      <div
        v-if="query.isFetching.value && !query.isPending.value"
        class="absolute top-0 left-0 right-0 h-0.5 bg-accent/20 z-20"
        data-testid="map-progress"
      >
        <div class="h-full w-1/3 bg-accent animate-pulse" />
      </div>

      <div
        v-if="query.isPending.value"
        class="absolute inset-0 z-30 flex items-center justify-center gap-6 bg-surface/40"
        data-testid="map-loading"
      >
        <div
          v-for="s in [28, 44, 36, 24]"
          :key="s"
          class="animate-pulse rounded-full bg-surface-2"
          :style="{ width: s + 'px', height: s + 'px' }"
        />
      </div>

      <!-- Native-OS-alert error state -->
      <div
        v-else-if="humanized"
        class="absolute inset-0 z-30"
        data-testid="map-error"
      >
        <div class="h-full flex flex-col items-center justify-center gap-3 text-center p-6">
          <div
            class="w-12 h-12 rounded-full bg-danger/15 flex items-center justify-center"
            aria-hidden="true"
          >
            <svg
              class="w-6 h-6 text-danger"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div class="text-md font-semibold text-text-primary">
            {{ humanized.title }}
          </div>
          <div class="text-sm text-text-muted max-w-md">
            {{ humanized.description }}
          </div>
          <Button
            variant="primary"
            size="md"
            data-testid="map-error-retry"
            @click="query.refetch()"
          >
            Újra
          </Button>
        </div>
      </div>

      <div
        v-else-if="nodes.length === 0"
        class="absolute inset-0 z-30"
        data-testid="map-empty"
      >
        <EmptyState
          title="Nincs adat ebben az idszakban"
          description="A kiválasztott ablakban egyetlen géptípus-csoportnak sincs ticketje."
        >
          <template #actions>
            <Button
              variant="secondary"
              size="md"
              data-testid="map-broaden"
              @click="broadenRange"
            >
              Időablak kiterjesztése
            </Button>
          </template>
        </EmptyState>
      </div>

      <!-- Hover tooltip — full model name + ticket count + color dot.
           The on-canvas label is the short version (e.g. "DPB-3-40");
           the tooltip shows the full thing (e.g. "DPB-3-40-0-...-120-RR-AT"). -->
      <div
        v-if="tooltip"
        class="fixed z-50 pointer-events-none bg-canvas-2 border border-border-default rounded-lg p-3 text-xs shadow-lg shadow-black/50 max-w-72"
        :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px', transition: 'left 60ms, top 60ms' }"
        data-testid="map-tooltip"
      >
        <div class="flex items-start gap-2">
          <span
            class="mt-1 inline-block w-2.5 h-2.5 rounded-full shrink-0"
            :style="{ backgroundColor: tooltip.node._color || '#888' }"
            aria-hidden="true"
          />
          <div class="min-w-0">
            <div class="font-mono text-text-primary break-all">{{ tooltip.node.model }}</div>
            <div class="text-text-muted mt-0.5">
              {{ tooltip.node.tickets }} ticket
            </div>
            <div
              v-if="tooltip.node.samples && tooltip.node.samples.length > 0"
              class="text-text-muted mt-1 line-clamp-2"
            >
              {{ tooltip.node.samples[0]!.snippet }}
            </div>
          </div>
        </div>
      </div>

      <!-- Node tap → side sheet -->
      <Drawer
        :open="selectedNode !== null"
        title="Géptípus"
        @update:open="selectedNode = null"
      >
        <template v-if="selectedNode">
          <div class="font-mono text-text-primary text-md">{{ selectedNode.model }}</div>
          <div class="text-xs text-text-muted mt-0.5">
            {{ selectedNode.tickets }} ticket · fels minták
          </div>

          <div
            v-if="selectedNode.samples && selectedNode.samples.length > 0"
            class="mt-4 space-y-2"
          >
            <div
              v-for="s in selectedNode.samples.slice(0, 2)"
              :key="s.sorszam"
              class="border border-border-subtle rounded-md p-3 bg-surface"
              data-testid="map-sample"
            >
              <span class="font-mono text-xs text-accent">{{ s.sorszam }}</span>
              <p class="text-sm text-text-secondary mt-1 line-clamp-3">{{ s.snippet }}</p>
            </div>
          </div>
          <p v-else class="text-xs text-text-muted mt-4">
            Ehhez a csoporthoz még nincs elérhető minta-ticket.
          </p>

          <div class="mt-6">
            <Button
              variant="secondary"
              size="md"
              data-testid="map-view-all"
              @click="viewAllInAsk(selectedNode)"
            >
              Összes megtekintése Ask-ban →
            </Button>
          </div>
        </template>
      </Drawer>
    </div>
  </div>
</template>
