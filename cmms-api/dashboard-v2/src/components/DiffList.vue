<script setup lang="ts">
// src/components/DiffList.vue
//
// Renders the filtered + selected list of diff items. Purely
// presentational — the parent owns the data + the filter state.
//
// Each row delegates to <DiffItem> for the visual treatment and
// emits `select` / `view-ticket` upward. This component adds only
// the list-level affordances: aria role, empty-filter state, and the
// "showing N of M" line at the top.
import { computed } from 'vue'
import type { DiffChange } from '@/lib/api'
import DiffItem from './DiffItem.vue'
import { categorizeChange, truncate } from '@/lib/diff'
import type { DiffCategory } from '@/lib/diff'

const props = defineProps<{
  changes: ReadonlyArray<DiffChange>
  filter: DiffCategory | 'all'
  selectedId: string | null
}>()

const emit = defineEmits<{
  (e: 'update:filter', value: DiffCategory | 'all'): void
  (e: 'update:selectedId', value: string | null): void
  (e: 'view-ticket', id: string): void
}>()

const visible = computed<DiffChange[]>(() => {
  if (props.filter === 'all') return [...props.changes]
  return props.changes.filter((c) => categorizeChange(c) === props.filter)
})

const totalCount = computed(() => props.changes.length)
const visibleCount = computed(() => visible.value.length)
const summary = computed(() => {
  if (props.filter === 'all') {
    return `Mind a ${totalCount.value} rekord megjelenítve.`
  }
  return truncate(
    `${visibleCount.value} / ${totalCount.value} rekord a „${props.filter}" kategóriában.`,
    200,
  )
})

function onSelect(id: string) {
  emit('update:selectedId', props.selectedId === id ? null : id)
}
function onViewTicket(id: string) {
  emit('view-ticket', id)
}
function clearFilter() {
  emit('update:filter', 'all')
}
</script>

<template>
  <section
    class="bg-surface"
    aria-label="Változások listája"
    data-testid="diff-list"
  >
    <header class="px-4 md:px-6 py-2.5 border-b border-border-subtle bg-surface/60">
      <p class="text-[12px] text-text-muted" data-testid="diff-list-summary">
        {{ summary }}
        <button
          v-if="filter !== 'all'"
          type="button"
          class="ml-2 text-nct-soft hover:text-text-primary underline-offset-2 hover:underline"
          data-testid="diff-clear-filter"
          @click="clearFilter"
        >
          Szűrő törlése
        </button>
      </p>
    </header>

    <ul
      v-if="visible.length > 0"
      class="divide-y divide-border-subtle"
      data-testid="diff-list-items"
    >
      <li v-for="change in visible" :key="`${change.t}-${change.id}`">
        <DiffItem
          :change="change"
          :selected="selectedId === change.id"
          @select="onSelect"
          @view-ticket="onViewTicket"
        />
      </li>
    </ul>

    <div
      v-else
      class="px-6 py-10 text-center text-text-muted text-sm"
      data-testid="diff-list-empty-filter"
    >
      <p>A kiválasztott kategóriában nincs megjeleníthető rekord.</p>
      <button
        type="button"
        class="mt-3 text-[12px] text-nct-soft hover:text-text-primary underline-offset-2 hover:underline"
        @click="clearFilter"
      >
        Szűrő törlése
      </button>
    </div>
  </section>
</template>
