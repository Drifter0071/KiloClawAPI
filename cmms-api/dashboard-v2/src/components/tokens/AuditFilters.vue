<script setup lang="ts">
// src/components/tokens/AuditFilters.vue
//
// Phase 5.5 — search box + group filter chips. Parent owns the
// reactive state; this component is purely presentational + emits
// change events so search can be debounced upstream.

import { ALL_GROUPS, type EventGroup } from './eventGrammar'

const props = defineProps<{
  search: string
  group: EventGroup | null
  /** When true, shows a "Szűrők törlése" affordance. */
  hasActiveFilters: boolean
  /** Currently visible entry count (after filtering). */
  visibleCount: number
  /** Total entries (before filtering). */
  totalCount: number
}>()

const emit = defineEmits<{
  (e: 'update:search', v: string): void
  (e: 'update:group', v: EventGroup | null): void
  (e: 'clear'): void
}>()
</script>

<template>
  <div
    data-testid="audit-filters"
    class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
  >
    <div class="flex-1 max-w-md">
      <label class="sr-only" for="audit-search">Események keresése</label>
      <div class="relative">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          aria-hidden="true"
        >
          <circle cx="9" cy="9" r="6" />
          <path d="m17 17-3.5-3.5" stroke-linecap="round" />
        </svg>
        <input
          id="audit-search"
          type="search"
          autocomplete="off"
          spellcheck="false"
          :value="props.search"
          placeholder="Események keresése…"
          data-testid="audit-search"
          class="w-full h-9 pl-9 pr-3 rounded-md bg-canvas-2 border border-border-subtle
                 text-sm text-text-primary placeholder:text-text-muted
                 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
          @input="emit('update:search', ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-text-muted">{{ visibleCount }} / {{ totalCount }}</span>

      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Eseménytípus szűrő">
        <button
          type="button"
          class="h-7 px-2.5 rounded-full text-[11px] font-medium border transition-colors"
          :class="props.group === null
            ? 'bg-accent text-text-inverse border-accent'
            : 'bg-canvas-2 text-text-secondary border-border-subtle hover:bg-surface-2'"
          data-testid="group-chip-all"
          @click="emit('update:group', null)"
        >
          Mind
        </button>
        <button
          v-for="g in ALL_GROUPS"
          :key="g.id"
          type="button"
          class="h-7 px-2.5 rounded-full text-[11px] font-medium border transition-colors"
          :class="props.group === g.id
            ? 'bg-accent text-text-inverse border-accent'
            : 'bg-canvas-2 text-text-secondary border-border-subtle hover:bg-surface-2'"
          :data-testid="`group-chip-${g.id}`"
          @click="emit('update:group', g.id)"
        >
          {{ g.label }}
        </button>
      </div>

      <button
        v-if="props.hasActiveFilters"
        type="button"
        class="h-7 px-2 text-xs text-text-muted hover:text-text-primary
               focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
        data-testid="clear-filters-btn"
        @click="emit('clear')"
      >
        Szűrők törlése
      </button>
    </div>
  </div>
</template>
