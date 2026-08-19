<script setup lang="ts">
// src/components/map/MapToolbar.vue
//
// Top toolbar for the Map page. Hosts every operator control:
//   - Period dropdown
//   - Grouping mode toggle (segmented control: family / type)
//   - Sort mode dropdown
//   - Search field
//   - View mode toggle (segmented control: map / list) — ALWAYS
//     reachable, even on mobile (moved to a dedicated row)
//   - Labels / Edges toggles
//   - Zoom in / out / fit
//   - Refresh button
//
// Layout: 3 rows on mobile (< md), 1 row on desktop. The view switcher
// lives on its own row (Row 3) on mobile so the user can always flip
// between Térkép and Lista even when Row 1 (period + group + sort) is
// horizontally scrolled off the right edge. On desktop everything is
// on a single horizontal row.
//
// All bound two-way via `v-model:*` so the parent (MapPage) keeps
// owning the reactive state.

import SegmentedControl from '@/components/SegmentedControl.vue'
import type { GroupingMode, SortMode } from '@/lib/mapLayout'

defineProps<{
  period: string
  groupingMode: GroupingMode
  sortMode: SortMode
  searchQuery: string
  viewMode: 'map' | 'list'
  showLabels: boolean
  showEdges: boolean
  isFetching: boolean
}>()

const emit = defineEmits<{
  (e: 'update:period', value: string): void
  (e: 'update:groupingMode', value: GroupingMode): void
  (e: 'update:sortMode', value: SortMode): void
  (e: 'update:searchQuery', value: string): void
  (e: 'update:viewMode', value: 'map' | 'list'): void
  (e: 'update:showLabels', value: boolean): void
  (e: 'update:showEdges', value: boolean): void
  (e: 'zoom-in'): void
  (e: 'zoom-out'): void
  (e: 'fit-view'): void
  (e: 'refresh'): void
}>()

const PERIOD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'this_month', label: 'Ebben a hónapban' },
  { value: 'last_30_days', label: 'Utolsó 30 nap' },
  { value: 'last_year', label: 'Tavaly' },
  { value: 'YTD', label: 'Idén' },
  { value: 'all', label: 'Minden idő' },
]

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: 'tickets', label: 'Ticket szám' },
  { value: 'name', label: 'Név' },
  { value: 'recent', label: 'Legutóbbi' },
]

// Grouping labels are full on desktop, short on mobile (to fit Row 1).
const GROUPING_OPTIONS: Array<{ value: GroupingMode; label: string; shortLabel: string }> = [
  { value: 'family', label: 'Család szerint', shortLabel: 'Család' },
  { value: 'type', label: 'Külön gépek', shortLabel: 'Külön' },
]

// View switcher labels: full on desktop, short on mobile.
const VIEW_OPTIONS: Array<{ value: 'map' | 'list'; label: string; shortLabel: string }> = [
  { value: 'map', label: 'Térkép', shortLabel: 'Térkép' },
  { value: 'list', label: 'Lista', shortLabel: 'Lista' },
]
</script>

<template>
  <div
    class="border-b border-border-subtle bg-canvas-2/60 shrink-0"
    data-testid="map-toolbar"
  >
    <!-- =============================================================
         Mobile: 3 rows. Row 1 = period + group + sort (horizontal scroll).
                            Row 2 = search + view switcher + labels/edges.
                            Row 3 = zoom + refresh (always reachable).
         ============================================================= -->
    <div class="md:hidden">
      <!-- Row 1: filters (period / group / sort) -->
      <div
        class="flex items-center gap-2 px-3 py-1.5 overflow-x-auto whitespace-nowrap"
        data-testid="map-toolbar-row-filters"
      >
        <label class="flex items-center gap-1 shrink-0">
          <select
            :value="period"
            aria-label="Időszak"
            class="h-7 pl-2 pr-7 rounded-md bg-surface border border-border-default text-text-primary text-xs focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 appearance-none"
            data-testid="map-toolbar-period"
            @change="emit('update:period', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="opt in PERIOD_OPTIONS" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>
        <SegmentedControl
          :model-value="groupingMode"
          :options="GROUPING_OPTIONS.map((g) => ({ value: g.value, label: g.shortLabel }))"
          aria-label="Csoportosítás"
          @update:model-value="(v: GroupingMode) => emit('update:groupingMode', v)"
        />
        <label class="flex items-center gap-1 shrink-0">
          <select
            :value="sortMode"
            aria-label="Rendezés"
            class="h-7 pl-2 pr-7 rounded-md bg-surface border border-border-default text-text-primary text-xs focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 appearance-none"
            data-testid="map-toolbar-sort"
            @change="emit('update:sortMode', ($event.target as HTMLSelectElement).value as SortMode)"
          >
            <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </label>
      </div>

      <!-- Row 2: search + view switcher + labels/edges -->
      <div
        class="flex items-center gap-2 px-3 py-1.5 border-t border-border-subtle"
        data-testid="map-toolbar-row-view"
      >
        <div class="flex items-center gap-1.5 min-w-0 flex-1">
          <svg
            class="w-3.5 h-3.5 text-text-muted shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="text"
            :value="searchQuery"
            placeholder="Keresés…"
            aria-label="Keresés"
            class="h-7 w-full px-2 rounded-md bg-surface border border-border-default text-text-primary text-xs placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 min-w-0"
            data-testid="map-toolbar-search"
            @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
          />
        </div>
        <SegmentedControl
          :model-value="viewMode"
          :options="VIEW_OPTIONS.map((v) => ({ value: v.value, label: v.shortLabel }))"
          aria-label="Nézet"
          data-testid="map-toolbar-view-mobile"
          @update:model-value="(v: 'map' | 'list') => emit('update:viewMode', v)"
        />
        <button
          type="button"
          role="switch"
          :aria-checked="showLabels"
          class="h-7 px-2 rounded-md border border-border-default bg-surface text-[10px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 shrink-0"
          :class="
            showLabels
              ? 'text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          "
          data-testid="map-toolbar-labels"
          @click="emit('update:showLabels', !showLabels)"
        >
          Címkék
        </button>
        <button
          type="button"
          role="switch"
          :aria-checked="showEdges"
          class="h-7 px-2 rounded-md border border-border-default bg-surface text-[10px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 shrink-0"
          :class="
            showEdges
              ? 'text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          "
          data-testid="map-toolbar-edges"
          @click="emit('update:showEdges', !showEdges)"
        >
          Élek
        </button>
      </div>

      <!-- Row 3: zoom + refresh (always reachable) -->
      <div
        class="flex items-center gap-1.5 px-3 py-1.5 border-t border-border-subtle"
        data-testid="map-toolbar-row-zoom"
      >
        <div class="flex items-center gap-0.5 shrink-0" data-testid="map-toolbar-zoom">
          <button
            type="button"
            class="w-7 h-7 rounded-md border border-border-default bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center justify-center"
            aria-label="Kicsinyítés"
            :disabled="viewMode !== 'map'"
            data-testid="map-toolbar-zoom-out"
            @click="emit('zoom-out')"
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            class="w-7 h-7 rounded-md border border-border-default bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center justify-center"
            aria-label="Illesztés"
            :disabled="viewMode !== 'map'"
            data-testid="map-toolbar-fit"
            @click="emit('fit-view')"
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 9V5a1 1 0 0 1 1-1h4" />
              <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
              <path d="M4 15v4a1 1 0 0 0 1 1h4" />
              <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
            </svg>
          </button>
          <button
            type="button"
            class="w-7 h-7 rounded-md border border-border-default bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center justify-center"
            aria-label="Nagyítás"
            :disabled="viewMode !== 'map'"
            data-testid="map-toolbar-zoom-in"
            @click="emit('zoom-in')"
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <div class="flex-1" />
        <button
          type="button"
          class="h-7 px-2.5 rounded-md border border-border-default bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center gap-1.5 shrink-0"
          aria-label="Frissítés"
          :disabled="isFetching"
          data-testid="map-refresh-mobile"
          @click="emit('refresh')"
        >
          <svg
            class="w-3.5 h-3.5"
            :class="isFetching ? 'animate-spin' : ''"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
          <span class="text-[11px] font-medium">Frissítés</span>
        </button>
      </div>
    </div>

    <!-- =============================================================
         Desktop: single row.
         ============================================================= -->
    <div
      class="hidden md:flex items-center gap-3 px-4 py-2 overflow-x-auto"
      data-testid="map-toolbar-row-desktop"
    >
      <label class="flex items-center gap-1.5 shrink-0">
        <span class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
          Időszak
        </span>
        <select
          :value="period"
          aria-label="Időszak"
          class="h-8 pl-2 pr-7 rounded-md bg-surface border border-border-default text-text-primary text-xs focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 appearance-none"
          data-testid="map-toolbar-period"
          @change="emit('update:period', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="opt in PERIOD_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <span class="w-px h-5 bg-border-subtle" aria-hidden="true" />
      <SegmentedControl
        :model-value="groupingMode"
        :options="GROUPING_OPTIONS.map((g) => ({ value: g.value, label: g.label }))"
        aria-label="Csoportosítás"
        @update:model-value="(v: GroupingMode) => emit('update:groupingMode', v)"
      />
      <label class="flex items-center gap-1.5 shrink-0">
        <span class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
          Rendezés
        </span>
        <select
          :value="sortMode"
          aria-label="Rendezés"
          class="h-8 pl-2 pr-7 rounded-md bg-surface border border-border-default text-text-primary text-xs focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 appearance-none"
          data-testid="map-toolbar-sort"
          @change="emit('update:sortMode', ($event.target as HTMLSelectElement).value as SortMode)"
        >
          <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <span class="w-px h-5 bg-border-subtle" aria-hidden="true" />
      <div class="flex items-center gap-1.5 min-w-[220px] shrink">
        <svg
          class="w-3.5 h-3.5 text-text-muted shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="text"
          :value="searchQuery"
          placeholder="Keresés a gépek között…"
          aria-label="Keresés"
          class="h-8 w-full px-2 rounded-md bg-surface border border-border-default text-text-primary text-xs placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
          data-testid="map-toolbar-search"
          @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <span class="w-px h-5 bg-border-subtle" aria-hidden="true" />
      <SegmentedControl
        :model-value="viewMode"
        :options="VIEW_OPTIONS.map((v) => ({ value: v.value, label: v.label }))"
        aria-label="Nézet"
        data-testid="map-toolbar-view-desktop"
        @update:model-value="(v: 'map' | 'list') => emit('update:viewMode', v)"
      />
      <span class="w-px h-5 bg-border-subtle" aria-hidden="true" />
      <button
        type="button"
        role="switch"
        :aria-checked="showLabels"
        class="h-8 px-2.5 rounded-md border border-border-default bg-surface text-[11px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 shrink-0"
        :class="
          showLabels
            ? 'text-text-primary'
            : 'text-text-muted hover:text-text-primary'
        "
        data-testid="map-toolbar-labels"
        @click="emit('update:showLabels', !showLabels)"
      >
        Cimkék
      </button>
      <button
        type="button"
        role="switch"
        :aria-checked="showEdges"
        class="h-8 px-2.5 rounded-md border border-border-default bg-surface text-[11px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 shrink-0"
        :class="
          showEdges
            ? 'text-text-primary'
            : 'text-text-muted hover:text-text-primary'
        "
        data-testid="map-toolbar-edges"
        @click="emit('update:showEdges', !showEdges)"
      >
        Élek
      </button>
      <span class="w-px h-5 bg-border-subtle" aria-hidden="true" />
      <div class="flex items-center gap-0.5 shrink-0" data-testid="map-toolbar-zoom">
        <button
          type="button"
          class="w-8 h-8 rounded-md border border-border-default bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center justify-center"
          aria-label="Kicsinyítés"
          :disabled="viewMode !== 'map'"
          data-testid="map-toolbar-zoom-out"
          @click="emit('zoom-out')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          type="button"
          class="w-8 h-8 rounded-md border border-border-default bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center justify-center"
          aria-label="Illesztés"
          :disabled="viewMode !== 'map'"
          data-testid="map-toolbar-fit"
          @click="emit('fit-view')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 9V5a1 1 0 0 1 1-1h4" />
            <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
            <path d="M4 15v4a1 1 0 0 0 1 1h4" />
            <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
          </svg>
        </button>
        <button
          type="button"
          class="w-8 h-8 rounded-md border border-border-default bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center justify-center"
          aria-label="Nagyítás"
          :disabled="viewMode !== 'map'"
          data-testid="map-toolbar-zoom-in"
          @click="emit('zoom-in')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        class="h-8 px-2.5 rounded-md border border-border-default bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 flex items-center gap-1.5 shrink-0"
        aria-label="Frissítés"
        :disabled="isFetching"
        data-testid="map-refresh"
        @click="emit('refresh')"
      >
        <svg
          class="w-3.5 h-3.5"
          :class="isFetching ? 'animate-spin' : ''"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
        <span class="text-[11px] font-medium">Frissítés</span>
      </button>
    </div>
  </div>
</template>
