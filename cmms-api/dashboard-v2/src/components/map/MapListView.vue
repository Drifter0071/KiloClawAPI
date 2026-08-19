<script setup lang="ts">
// src/components/map/MapListView.vue
//
// Accessible tabular alternative to the cytoscape map. Used when
// `viewMode === 'list'` (the user clicks the "List" toggle in the
// toolbar) — the same dataset is shown as a sortable, filterable
// table.
//
// Columns:
//   - model: the full machine name
//   - family: the family / type key (used for grouping)
//   - tickets: ticket count, right-aligned, tabular numerals
//   - last seen: ISO timestamp of the most recent sample (or —)
//
// Clicking a row emits `select-node` with the node's id so the
// parent (MapPage) can open the inspector drawer.

import { computed, ref, watch } from 'vue'
import type { NormalizedMapNode } from '@/lib/mapNormalization'

type SortKey = 'model' | 'family' | 'tickets' | 'lastSeen'
type SortDir = 'asc' | 'desc'

const props = defineProps<{
  nodes: NormalizedMapNode[]
}>()

const emit = defineEmits<{
  (e: 'select-node', id: string): void
}>()

const PAGE_SIZE = 50

const search = ref<string>('')
const sortKey = ref<SortKey>('tickets')
const sortDir = ref<SortDir>('desc')
const page = ref<number>(1)

/** Reset to page 1 whenever the upstream node list (which the parent
 *  recomputes on every period / sort / grouping / search change) or
 *  the local search / sort change. Without this the user can be left
 *  on page 7 of the OLD sorted set after switching the period. */
watch(
  () => [props.nodes, search, sortKey, sortDir],
  () => {
    page.value = 1
  },
)

/** Last-seen timestamp (ms) for sorting — falls back to 0 when no
 *  sample carries a parseable ISO datetime. */
function lastSeenMs(node: NormalizedMapNode): number {
  let best = 0
  for (const s of node.samples) {
    const t = (s as unknown as { reported_at_iso?: string }).reported_at_iso
    if (typeof t === 'string') {
      const parsed = Date.parse(t)
      if (!Number.isNaN(parsed) && parsed > best) best = parsed
    }
  }
  return best
}

function formatLastSeen(node: NormalizedMapNode): string {
  const ms = lastSeenMs(node)
  if (ms <= 0) return '—'
  try {
    const d = new Date(ms)
    // YYYY-MM-DD HH:MM — Hungarian-locale users prefer this over
    // AM/PM or 12-hour times. JS toISOString gives "YYYY-MM-DDTHH:MM:SS"
    // so we slice + replace.
    return d.toISOString().slice(0, 16).replace('T', ' ')
  } catch {
    return '—'
  }
}

const filteredNodes = computed<NormalizedMapNode[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.nodes
  return props.nodes.filter((n) => {
    if (n.id.toLowerCase().includes(q)) return true
    if (n.label.toLowerCase().includes(q)) return true
    if (n.familyKey.toLowerCase().includes(q)) return true
    if (n.familyLabel.toLowerCase().includes(q)) return true
    return false
  })
})

const sortedNodes = computed<NormalizedMapNode[]>(() => {
  const key = sortKey.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  const arr = filteredNodes.value.slice()
  arr.sort((a, b) => {
    let av: string | number
    let bv: string | number
    switch (key) {
      case 'model':
        av = a.id
        bv = b.id
        break
      case 'family':
        av = a.familyKey
        bv = b.familyKey
        break
      case 'lastSeen':
        av = lastSeenMs(a)
        bv = lastSeenMs(b)
        break
      case 'tickets':
      default:
        av = a.tickets
        bv = b.tickets
        break
    }
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    return a.id.localeCompare(b.id)
  })
  return arr
})

/** Total page count for the current filter+sort slice. */
const totalPages = computed<number>(() => {
  const n = sortedNodes.value.length
  if (n <= PAGE_SIZE) return 1
  return Math.ceil(n / PAGE_SIZE)
})

/** Slice of `sortedNodes` for the current page. */
const pagedNodes = computed<NormalizedMapNode[]>(() => {
  const all = sortedNodes.value
  const start = (page.value - 1) * PAGE_SIZE
  return all.slice(start, start + PAGE_SIZE)
})

function goToPage(p: number) {
  if (p < 1) p = 1
  if (p > totalPages.value) p = totalPages.value
  page.value = p
}

function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    // Default direction per column: text columns ascending, numbers
    // descending (most tickets / most recent first).
    sortDir.value = key === 'tickets' || key === 'lastSeen' ? 'desc' : 'asc'
  }
}

function arrowFor(key: SortKey): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? '▲' : '▼'
}

function onRowClick(node: NormalizedMapNode) {
  emit('select-node', node.id)
}

function onRowKeydown(evt: KeyboardEvent, node: NormalizedMapNode) {
  if (evt.key === 'Enter' || evt.key === ' ') {
    evt.preventDefault()
    onRowClick(node)
  }
}
</script>

<template>
  <div
    class="absolute inset-0 overflow-auto bg-canvas p-4 md:p-6"
    data-testid="map-list-view"
  >
    <div
      class="rounded-lg border border-border-subtle bg-surface overflow-hidden"
    >
      <!-- Filter bar -->
      <div
        class="px-4 py-3 border-b border-border-subtle flex items-center gap-3"
      >
        <input
          v-model="search"
          type="text"
          placeholder="Szűrés a listában…"
          aria-label="Szűrés a listában"
          class="flex-1 h-8 px-3 rounded-md bg-canvas-2 border border-border-default text-text-primary text-xs placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
          data-testid="map-list-search"
        />
        <span class="text-[11px] font-mono text-text-muted whitespace-nowrap">
          {{ sortedNodes.length }} / {{ nodes.length }} gép
        </span>
      </div>

      <!-- Table -->
      <div class="overflow-x-auto">
        <table
          class="w-full text-sm border-collapse"
          data-testid="map-list-table"
        >
          <thead>
            <tr
              class="bg-canvas-2 text-text-muted text-[10px] font-mono uppercase tracking-wider"
            >
              <th
                v-for="col in [
                  { key: 'model', label: 'Gép' },
                  { key: 'family', label: 'Család' },
                  { key: 'tickets', label: 'Ticket', align: 'right' },
                  { key: 'lastSeen', label: 'Utoljára', align: 'right' },
                ]"
                :key="col.key"
                scope="col"
                class="px-4 py-2 font-semibold"
                :class="col.align === 'right' ? 'text-right' : 'text-left'"
              >
                <button
                  type="button"
                  class="inline-flex items-center gap-1 hover:text-text-primary transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
                  :class="col.align === 'right' ? 'flex-row-reverse' : ''"
                  :aria-sort="
                    sortKey === col.key
                      ? sortDir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  "
                  :data-testid="`map-list-sort-${col.key}`"
                  @click="setSort(col.key as SortKey)"
                >
                  <span>{{ col.label }}</span>
                  <span class="text-[8px]" aria-hidden="true">{{ arrowFor(col.key as SortKey) }}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="n in pagedNodes"
              :key="n.id"
              tabindex="0"
              role="button"
              :aria-label="`${n.label}, ${n.tickets} ticket, ${n.familyLabel} család`"
              class="border-t border-border-subtle hover:bg-surface-2 focus:bg-surface-2 focus:outline-none cursor-pointer transition-colors duration-150"
              :data-testid="`map-list-row-${n.id}`"
              @click="onRowClick(n)"
              @keydown="onRowKeydown($event, n)"
            >
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-2 min-w-0">
                  <span
                    class="shrink-0 rounded-full"
                    :style="{
                      width: '8px',
                      height: '8px',
                      backgroundColor: n.color,
                    }"
                    aria-hidden="true"
                  />
                  <span class="truncate text-text-primary" :title="n.label">
                    {{ n.label }}
                  </span>
                </div>
              </td>
              <td class="px-4 py-2.5 text-text-secondary">
                <span class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface-2 border border-border-subtle">
                  {{ n.familyLabel }}
                </span>
              </td>
              <td class="px-4 py-2.5 text-right tabular-nums text-text-primary font-mono">
                {{ n.tickets.toLocaleString('hu-HU') }}
              </td>
              <td class="px-4 py-2.5 text-right font-mono text-[11px] text-text-muted whitespace-nowrap">
                {{ formatLastSeen(n) }}
              </td>
            </tr>
            <tr v-if="sortedNodes.length === 0">
              <td
                colspan="4"
                class="px-4 py-12 text-center text-text-muted"
                data-testid="map-list-empty"
              >
                Nincs megjeleníthető gép.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination footer (only when there's more than one page) -->
      <div
        v-if="totalPages > 1"
        class="px-4 py-3 border-t border-border-subtle flex items-center justify-between gap-3"
        data-testid="map-list-pagination"
      >
        <span class="text-[11px] font-mono text-text-muted">
          {{ page }} / {{ totalPages }} oldal
        </span>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="h-7 px-2.5 rounded-md border border-border-default bg-canvas-2 text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-medium"
            :disabled="page <= 1"
            data-testid="map-list-page-prev"
            @click="goToPage(page - 1)"
          >
            ← Előző
          </button>
          <button
            type="button"
            class="h-7 px-2.5 rounded-md border border-border-default bg-canvas-2 text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-medium"
            :disabled="page >= totalPages"
            data-testid="map-list-page-next"
            @click="goToPage(page + 1)"
          >
            Következő →
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
