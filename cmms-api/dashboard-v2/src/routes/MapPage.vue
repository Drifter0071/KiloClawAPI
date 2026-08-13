<script setup lang="ts">
// src/routes/MapPage.vue
//
// Spatial Map — spec §5.3. Renders machine-type ticket volume as a
// Cytoscape node graph (nodes only; no edge endpoint exists in v1).
//
//   - Period selector auto-submits (vue-query key = period).
//   - Node size/color comes from lib/cytoscape.ts (sqrt-scaled, buckets).
//   - Click → side sheet with the top sample tickets + "View all in Ask →".
//   - Hover → floating tooltip card that follows the mouse.
//   - No raw JSON: errors go through humanizeError().

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { Core } from 'cytoscape'
import Button from '@/components/Button.vue'
import Drawer from '@/components/Drawer.vue'
import EmptyState from '@/components/EmptyState.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import Skeleton from '@/components/Skeleton.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { setSeedQ } from '@/composables/useSeedQ'
import { makeCyto } from '@/lib/cytoscape'
import { humanizeError } from '@/lib/errors'
import type { MapNode } from '@/lib/api'

// ---------------------------------------------------------------------------
// Period selector — auto-submits via the vue-query key
// ---------------------------------------------------------------------------

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
const humanized = computed(() => (query.error.value ? humanizeError(query.error.value) : null))

// ---------------------------------------------------------------------------
// Cytoscape lifecycle — rebuild on every data change / period switch
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
    (n, evt) => {
      showTooltip(n, evt.clientX, evt.clientY)
    },
  )
}

// Selected node → side sheet. Hover tooltip lives on the canvas (below).
const selectedNode = ref<MapNode | null>(null)

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
// Tooltip — follows the mouse (60ms transition via inline style)
// ---------------------------------------------------------------------------

const tooltip = ref<{ x: number; y: number; node: MapNode } | null>(null)

/** The cy instance exposes raw canvas coords; we track the DOM mouse
 *  position on the container instead (simpler + stable across layouts). */
function onMouseMove(evt: MouseEvent) {
  if (tooltip.value) {
    tooltip.value.x = evt.clientX + 14
    tooltip.value.y = evt.clientY + 14
  }
}

function onMouseLeave() {
  tooltip.value = null
}

function showTooltip(node: MapNode, x: number, y: number) {
  tooltip.value = { x: x + 14, y: y + 14, node }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function viewAllInAsk(node: MapNode) {
  setSeedQ(node.model || node.raw)
}

function broadenRange() {
  period.value = 'all'
}
</script>

<template>
  <div class="h-full flex flex-col" data-testid="map-page">
    <!-- Title row -->
    <div
      class="h-12 px-6 flex items-center justify-between border-b border-border-subtle shrink-0"
    >
      <div class="flex flex-col justify-center">
        <div class="text-md font-semibold text-text-primary">Géptípus-térkép</div>
        <div class="text-xs text-text-muted">
          Géptípusonkénti ticket-mennyiség · csomópont méret = ticket szám
        </div>
      </div>
      <div class="flex items-center gap-3">
        <SegmentedControl
          v-model="period"
          :options="PERIOD_OPTIONS"
          aria-label="Térkép idszaka"
          data-testid="map-period"
        />
        <button
          type="button"
          class="w-8 h-8 rounded-md border border-border-default text-text-muted hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center justify-center"
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
    </div>

    <!-- Canvas -->
    <div
      class="flex-1 relative overflow-hidden bg-surface"
      data-testid="map-canvas"
      @mousemove="onMouseMove"
      @mouseleave="onMouseLeave"
    >
      <!-- Grid background (24px, 3% white) -->
      <div
        class="absolute inset-0"
        :style="{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }"
      />

      <!-- The cytoscape host -->
      <div ref="canvasEl" class="absolute inset-0" data-testid="map-cy" />

      <!-- 2px sky-500 progress bar during any fetch -->
      <div
        v-if="query.isFetching.value"
        class="absolute top-0 left-0 right-0 h-0.5 bg-accent/20 z-20"
        data-testid="map-progress"
      >
        <div class="h-full w-1/3 bg-accent animate-pulse" />
      </div>

      <!-- Loading overlay: pulsing node-shaped placeholders -->
      <div
        v-if="query.isPending.value"
        class="absolute inset-0 z-30 flex items-center justify-center gap-6 bg-surface/40"
        data-testid="map-loading"
      >
        <div v-for="s in [28, 44, 36, 24]" :key="s" class="animate-pulse rounded-full bg-surface-2" :style="{ width: s + 'px', height: s + 'px' }" />
      </div>

      <!-- Error state -->
      <div
        v-else-if="humanized"
        class="absolute inset-0 z-30"
        data-testid="map-error"
      >
        <div class="h-full flex flex-col items-center justify-center gap-3 text-center p-6">
          <svg
            class="w-12 h-12 text-danger"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div class="text-md font-medium text-text-primary">{{ humanized.title }}</div>
          <div class="text-sm text-text-muted max-w-md">{{ humanized.description }}</div>
          <Button variant="secondary" size="md" data-testid="map-error-retry" @click="query.refetch()">
            Újra
          </Button>
        </div>
      </div>

      <!-- Empty state -->
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
            <Button variant="secondary" size="md" data-testid="map-broaden" @click="broadenRange">
              Idablak kiterjesztése
            </Button>
          </template>
        </EmptyState>
      </div>

      <!-- Hover tooltip -->
      <div
        v-if="tooltip"
        class="fixed z-50 pointer-events-none bg-canvas-2 border border-border-subtle rounded-md p-3 text-xs shadow-lg shadow-black/40"
        :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px', transition: 'left 60ms, top 60ms' }"
        data-testid="map-tooltip"
      >
        <div class="font-mono text-text-primary">{{ tooltip.node.model }}</div>
        <div class="text-text-muted mt-0.5">{{ tooltip.node.tickets }} ticket</div>
        <div
          v-if="tooltip.node.samples && tooltip.node.samples.length > 0"
          class="text-text-muted mt-1 max-w-56 truncate"
        >
          {{ tooltip.node.samples[0]!.snippet }}
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

          <div v-if="selectedNode.samples && selectedNode.samples.length > 0" class="mt-4 space-y-3">
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
            Ehhez a csoporthoz még nincs elérhet minta-ticket.
          </p>

          <div class="mt-6">
            <Button variant="secondary" size="md" data-testid="map-view-all" @click="viewAllInAsk(selectedNode)">
              Összes megtekintése Ask-ban →
            </Button>
          </div>
        </template>
      </Drawer>
    </div>
  </div>
</template>
