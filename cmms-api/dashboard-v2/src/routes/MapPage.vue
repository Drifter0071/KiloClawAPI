<script setup lang="ts">
// src/routes/MapPage.vue
//
// NCT Szerviz Ai v2 — Spatial Machine Relationship Map (Phase 7 Redesign).
//
// Features:
//   - Deterministic clustered layout algorithm: zero node/label overlaps, stable positions.
//   - Normalized data model: deduplication, non-machine label filtering, square-root ticket scaling.
//   - Interactive map canvas: Cytoscape with neighbor highlighting, zoom, fit view, labels/edges toggle.
//   - Operational summary & legend: visible machines, ticket counts, family groups, dropped count.
//   - Inspection drawer: machine details, sample tickets with sorszam links, same-family related machines.
//   - Standalone TicketInspector drawer: opens when a ticket sorszam is clicked.
//   - Accessible List View alternative: filterable and sortable tabular view.
//   - URL state synchronization: period, view, search query, grouping mode.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'

import Button from '@/components/Button.vue'
import EmptyState from '@/components/EmptyState.vue'
import TicketInspector from '@/components/TicketInspector.vue'
import MapLegend from '@/components/map/MapLegend.vue'
import MapListView from '@/components/map/MapListView.vue'
import MapNodeInspector from '@/components/map/MapNodeInspector.vue'
import MapNodeTooltip from '@/components/map/MapNodeTooltip.vue'
import MapSummary from '@/components/map/MapSummary.vue'
import MapToolbar from '@/components/map/MapToolbar.vue'

import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { createMapGraph, getActiveTheme, type MapGraphController } from '@/lib/cytoscape'
import { humanizeError } from '@/lib/errors'
import { generateMapLayout, type GroupingMode, type SortMode } from '@/lib/mapLayout'
import { normalizeMapData, type NormalizedMapNode } from '@/lib/mapNormalization'
import type { EvidenceTicket } from '@/lib/api'

// ---------------------------------------------------------------------------
// Route & URL State Sync
// ---------------------------------------------------------------------------

const route = useRoute()
const router = useRouter()

const period = ref<string>((route.query.period as string) || 'this_month')
const viewMode = ref<'map' | 'list'>((route.query.view as 'map' | 'list') || 'map')
const searchQuery = ref<string>((route.query.q as string) || '')
const groupingMode = ref<GroupingMode>((route.query.grouping as GroupingMode) || 'family')
const sortMode = ref<SortMode>((route.query.sort as SortMode) || 'tickets')

const showLabels = ref<boolean>(true)
const showEdges = ref<boolean>(true)

// Sync state to URL query params without triggering full page reloads
watch([period, viewMode, searchQuery, groupingMode, sortMode], () => {
  router.replace({
    query: {
      ...route.query,
      period: period.value !== 'this_month' ? period.value : undefined,
      view: viewMode.value !== 'map' ? viewMode.value : undefined,
      q: searchQuery.value || undefined,
      grouping: groupingMode.value !== 'family' ? groupingMode.value : undefined,
      sort: sortMode.value !== 'tickets' ? sortMode.value : undefined,
    },
  })
})

// ---------------------------------------------------------------------------
// Data Fetching & Normalization
// ---------------------------------------------------------------------------

const query = useQuery({
  queryKey: ['map', period],
  queryFn: withAutoRetry(() => useApi().map(period.value)),
})

const normalizedData = computed(() => {
  const rawNodes = query.data.value?.nodes || []
  return normalizeMapData(rawNodes)
})

const layoutResult = computed(() => {
  return generateMapLayout(normalizedData.value, {
    groupingMode: groupingMode.value,
    sortMode: sortMode.value,
    searchQuery: searchQuery.value,
    showEdges: showEdges.value,
    showLabels: showLabels.value,
  })
})

const humanizedError = computed(() =>
  query.error.value ? humanizeError(query.error.value) : null,
)

// ---------------------------------------------------------------------------
// Cytoscape Lifecycle & Canvas Controller
// ---------------------------------------------------------------------------

const canvasEl = ref<HTMLElement | null>(null)
let graph: MapGraphController | null = null
let themeObserver: MutationObserver | null = null

const selectedNodeId = ref<string | null>(null)
const selectedNode = computed<NormalizedMapNode | null>(() => {
  if (!selectedNodeId.value) return null
  return normalizedData.value.nodes.find((n: NormalizedMapNode) => n.id === selectedNodeId.value) || null
})

const isInspectorOpen = ref<boolean>(false)

// Hover Tooltip State
const tooltipState = ref<{
  node: NormalizedMapNode
  x: number
  y: number
} | null>(null)

function mountGraph() {
  if (!canvasEl.value) return
  if (graph) {
    graph.destroy()
    graph = null
  }
  graph = createMapGraph(canvasEl.value, layoutResult.value.elements, {
    onClick: (nodeId: string) => {
      selectedNodeId.value = nodeId
      isInspectorOpen.value = nodeId !== null
    },
    onHover: (nodeId: string | null, evt: MouseEvent) => {
      if (!nodeId) {
        tooltipState.value = null
        return
      }
      const node = normalizedData.value.nodes.find((n: NormalizedMapNode) => n.id === nodeId)
      if (node) {
        tooltipState.value = {
          node,
          x: evt.clientX + 16,
          y: evt.clientY + 16,
        }
      }
    },
  })
  graph.setShowLabels(showLabels.value)
  graph.setShowEdges(showEdges.value)
}

function unmountGraph() {
  if (graph) {
    graph.destroy()
    graph = null
  }
}

// Re-mount the graph when switching view modes (map ↔ list).
watch(viewMode, () => {
  if (viewMode.value === 'map') {
    nextTick(mountGraph)
  } else {
    unmountGraph()
  }
})

// In-place element updates (preserves pan/zoom). The set is only replaced
// when the rendered element set actually changes; cosmetic changes
// (sort, labels, edges) are applied via setShowLabels / setShowEdges so
// the user keeps their zoom/pan.
watch(
  () => layoutResult.value.elements,
  (newEls, oldEls) => {
    if (viewMode.value !== 'map' || !graph) return
    if (newEls === oldEls) return
    if (newEls.length === 0) return
    graph.setElements(newEls)
  },
  { flush: 'post' },
)

// Toggle handlers must re-apply on the live graph (no rebuild).
watch(showLabels, (v) => graph?.setShowLabels(v))
watch(showEdges, (v) => graph?.setShowEdges(v))

onMounted(() => {
  if (viewMode.value === 'map') {
    nextTick(mountGraph)
  }
  // Watch the html data-theme attribute so we can re-color the graph
  // when the user toggles dark/light via ThemeToggle.
  if (typeof document !== 'undefined') {
    themeObserver = new MutationObserver(() => {
      graph?.setTheme(getActiveTheme())
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
  }
})

onBeforeUnmount(() => {
  unmountGraph()
  themeObserver?.disconnect()
  themeObserver = null
})

// ---------------------------------------------------------------------------
// Canvas Controls Actions
// ---------------------------------------------------------------------------

function handleZoomIn() {
  graph?.zoomIn()
}

function handleZoomOut() {
  graph?.zoomOut()
}

function handleFitView() {
  graph?.fit()
}

function selectNodeById(id: string) {
  selectedNodeId.value = id
  isInspectorOpen.value = true
  graph?.centerOn(id)
}

// ---------------------------------------------------------------------------
// Ticket Inspector Drawer (opens when a ticket sorszam is clicked)
// ---------------------------------------------------------------------------

const inspectingTicket = ref<EvidenceTicket | null>(null)
const isTicketInspectorOpen = ref<boolean>(false)

function onSorszamClick(payload: { prefix: string; sorszam: string }) {
  if (payload.prefix === 'B') {
    inspectingTicket.value = {
      sorszam: payload.sorszam,
      key: payload.sorszam,
      reported_at_iso: new Date().toISOString(),
      snippet: '',
      kategoria: null,
      kategoria_inferred: null,
      sulyossag_inferred: null,
    }
    isTicketInspectorOpen.value = true
  }
}

function clearFilters() {
  searchQuery.value = ''
}

function broadenRange() {
  period.value = 'all'
  searchQuery.value = ''
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-canvas select-none" data-testid="map-page">
    <!-- Header -->
    <header class="h-13 px-4 md:px-6 flex items-center justify-between border-b border-border-subtle bg-canvas-2/60 shrink-0">
      <div class="min-w-0">
        <h1 class="text-[15px] font-semibold tracking-tight text-text-primary leading-none">
          Géptípus-térkép
        </h1>
        <p class="text-[12px] text-text-muted mt-1 truncate">
          Géptípusonkénti ticket-mennyiség · csomópont méret = ticket szám
        </p>
      </div>
    </header>

    <!-- Operational Toolbar -->
    <MapToolbar
      v-model:period="period"
      v-model:groupingMode="groupingMode"
      v-model:sortMode="sortMode"
      v-model:searchQuery="searchQuery"
      v-model:viewMode="viewMode"
      v-model:showLabels="showLabels"
      v-model:showEdges="showEdges"
      :is-fetching="query.isFetching.value"
      @zoom-in="handleZoomIn"
      @zoom-out="handleZoomOut"
      @fit-view="handleFitView"
      @refresh="query.refetch()"
    />

    <!-- Main Workspace Container -->
    <div
      class="flex-1 relative overflow-hidden bg-surface"
      :class="{ 'pb-14 md:pb-0': viewMode === 'list' }"
    >
      <!-- Ambient Grid Background -->
      <div
        class="absolute inset-0 pointer-events-none"
        :style="{
          backgroundImage:
            'linear-gradient(var(--color-border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--color-border-subtle) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          opacity: 0.4,
        }"
      />

      <!-- Map View Canvas -->
      <div
        v-show="viewMode === 'map'"
        ref="canvasEl"
        class="absolute inset-0 z-0"
        data-testid="map-cy"
      />

      <!-- List View Alternative -->
      <MapListView
        v-if="viewMode === 'list'"
        :nodes="layoutResult.visibleNodes"
        class="relative z-10"
        @select-node="selectNodeById"
      />

      <!-- Floating Summary Badge (Bottom-Left) -->
      <div
        v-if="!query.isPending.value && !humanizedError && (layoutResult.visibleNodesCount > 0 || normalizedData.droppedCount > 0)"
        class="absolute bottom-4 left-4 z-10 pointer-events-auto"
      >
        <MapSummary
          :visible-nodes-count="layoutResult.visibleNodesCount"
          :total-tickets="layoutResult.totalTickets"
          :visible-groups-count="layoutResult.visibleGroupsCount"
          :dropped-count="normalizedData.droppedCount"
          :dropped-total-tickets="normalizedData.droppedTotalTickets"
          :search-query="searchQuery"
          @clear-search="clearFilters"
        />
      </div>

      <!-- Floating Legend (Top-Left) -->
      <div
        v-if="viewMode === 'map' && !query.isPending.value && !humanizedError && layoutResult.visibleNodesCount > 0"
        class="absolute top-4 left-4 z-10 pointer-events-auto max-w-xs"
      >
        <MapLegend :max-tickets="normalizedData.maxTickets" />
      </div>

      <!-- Fetching Progress Bar -->
      <div
        v-if="query.isFetching.value && !query.isPending.value"
        class="absolute top-0 left-0 right-0 h-0.5 bg-accent/20 z-20"
        data-testid="map-progress"
      >
        <div class="h-full w-1/3 bg-accent animate-pulse" />
      </div>

      <!-- Loading State -->
      <div
        v-if="query.isPending.value"
        class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-surface/80 backdrop-blur-sm"
        data-testid="map-loading"
      >
        <div class="flex items-center gap-4">
          <div
            v-for="s in [28, 44, 36, 24]"
            :key="s"
            class="animate-pulse rounded-full bg-surface-2"
            :style="{ width: `${s}px`, height: `${s}px` }"
          />
        </div>
        <p class="text-xs font-mono text-text-muted">Gépkapcsolati térkép betöltése…</p>
      </div>

      <!-- Native-OS Error State -->
      <div
        v-else-if="humanizedError"
        class="absolute inset-0 z-30 bg-surface/90 flex flex-col items-center justify-center p-6 text-center"
        data-testid="map-error"
      >
        <div class="w-12 h-12 rounded-full bg-danger/15 flex items-center justify-center mb-3">
          <svg class="w-6 h-6 text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h2 class="text-base font-semibold text-text-primary">{{ humanizedError.title }}</h2>
        <p class="text-xs text-text-muted max-w-md mt-1 mb-4">{{ humanizedError.description }}</p>
        <Button variant="primary" size="md" data-testid="map-error-retry" @click="query.refetch()">
          Újra
        </Button>
      </div>

      <!-- Empty State -->
      <div
        v-else-if="layoutResult.visibleNodesCount === 0"
        class="absolute inset-0 z-30"
        data-testid="map-empty"
      >
        <EmptyState
          title="Nincs gép ebben az időszakban"
          description="A kiválasztott szűrőknek egyetlen géptípus-csoport sem felel meg."
        >
          <template #actions>
            <Button variant="secondary" size="md" data-testid="map-broaden" @click="broadenRange">
              Szűrők törlése és időablak kiterjesztése
            </Button>
          </template>
        </EmptyState>
      </div>

      <!-- Hover Tooltip -->
      <MapNodeTooltip
        v-if="viewMode === 'map' && tooltipState"
        :node="tooltipState.node"
        :x="tooltipState.x"
        :y="tooltipState.y"
      />

      <!-- Machine Node Inspector Drawer -->
      <MapNodeInspector
        v-model:open="isInspectorOpen"
        :node="selectedNode"
        :all-nodes="normalizedData.nodes"
        :period="period"
        @select-node="selectNodeById"
        @sorszam-click="onSorszamClick"
      />

      <!-- Standalone Ticket Inspector Drawer -->
      <TicketInspector
        v-model:open="isTicketInspectorOpen"
        :ticket="inspectingTicket"
      />
    </div>
  </div>
</template>
