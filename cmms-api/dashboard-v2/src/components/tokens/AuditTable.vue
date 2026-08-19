<script setup lang="ts">
// src/components/tokens/AuditTable.vue
//
// Phase 5.5 — desktop table OR mobile cards, gated by media query.
// Renders the audit log rows + opens a detail drawer on row click.

import { computed } from 'vue'
import type { AuditEntry } from '@/lib/api'
import { useMediaQuery } from '@/composables/useMediaQuery'
import EventBadge from './EventBadge.vue'
import Skeleton from '@/components/Skeleton.vue'

const props = defineProps<{
  entries: AuditEntry[]
  loading: boolean
  /** True when entries has 0 items AND loading is false. */
  empty: boolean
}>()

const emit = defineEmits<{
  (e: 'open', entry: AuditEntry): void
  (e: 'loadMore'): void
  (e: 'retry'): void
}>()

const isDesktop = useMediaQuery('(min-width: 768px)')

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

const visibleCount = computed(() => props.entries.length)
const isEmpty = computed(() => props.empty)
const showTable = computed(() => isDesktop.value)
</script>

<template>
  <div data-testid="audit-table" class="space-y-3">
    <!-- Loading: 6 skeleton rows -->
    <template v-if="loading">
      <div
        v-if="showTable"
        class="bg-surface border border-border-subtle rounded-lg overflow-hidden"
      >
        <table class="w-full text-left border-separate border-spacing-0">
          <thead>
            <tr>
              <th class="bg-surface-2/60 px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-40">
                Időpont
              </th>
              <th class="bg-surface-2/60 px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-32">
                Esemény
              </th>
              <th class="bg-surface-2/60 px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-36">
                Eszköz
              </th>
              <th class="bg-surface-2/60 px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-24">
                Felhasználó
              </th>
              <th class="bg-surface-2/60 px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium">
                Részletek
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in 6" :key="i">
              <td colspan="5" class="px-4 py-1.5">
                <Skeleton h="h-9" w="w-full" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="space-y-2">
        <div v-for="i in 6" :key="i" class="bg-surface border border-border-subtle rounded-lg p-3">
          <Skeleton h="h-3" w="w-32" />
          <div class="mt-2"><Skeleton h="h-3" w="w-20" /></div>
          <div class="mt-2"><Skeleton h="h-3" w="w-full" /></div>
        </div>
      </div>
    </template>

    <!-- Empty -->
    <div
      v-else-if="isEmpty"
      data-testid="audit-empty"
      class="bg-surface border border-border-subtle rounded-lg p-8 text-center"
    >
      <div class="text-sm text-text-muted">Nincs megjeleníthető biztonsági esemény.</div>
      <p class="text-xs text-text-muted mt-1">
        A jelenlegi szűrők egy bejegyzést sem adnak vissza.
      </p>
    </div>

    <!-- Desktop: real table -->
    <div
      v-else-if="showTable"
      class="bg-surface border border-border-subtle rounded-lg overflow-hidden"
    >
      <div class="max-h-[60vh] overflow-y-auto">
        <table class="w-full text-left border-separate border-spacing-0">
          <thead>
            <tr>
              <th
                class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle
                       px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-40"
              >
                Időpont
              </th>
              <th
                class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle
                       px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-32"
              >
                Esemény
              </th>
              <th
                class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle
                       px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-36"
              >
                Eszköz
              </th>
              <th
                class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle
                       px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-24"
              >
                Felhasználó
              </th>
              <th
                class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle
                       px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium"
              >
                Részletek
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in entries"
              :key="`${entry.t}-${entry.action}`"
              data-testid="audit-row"
              role="button"
              tabindex="0"
              class="cursor-pointer hover:bg-surface-2/60 focus-visible:bg-surface-2/60
                     transition-colors duration-150 outline-none
                     focus-visible:ring-2 focus-visible:ring-accent/40"
              @click="emit('open', entry)"
              @keydown.enter.self="emit('open', entry)"
              @keydown.space.prevent="emit('open', entry)"
            >
              <td
                class="px-4 py-2 whitespace-nowrap font-mono text-xs text-text-muted tabular-nums"
                data-testid="audit-time"
              >
                {{ formatTime(entry.t) }}
              </td>
              <td class="px-4 py-2">
                <EventBadge :action="String(entry.action)" />
              </td>
              <td class="px-4 py-2 font-mono text-xs text-text-secondary whitespace-nowrap">
                {{ entry.tool ?? '—' }}
              </td>
              <td class="px-4 py-2 text-xs text-text-secondary whitespace-nowrap">
                {{ entry.user ?? '—' }}
              </td>
              <td
                class="px-4 py-2 text-sm text-text-secondary max-w-0 truncate"
                :title="entry.detail"
              >
                {{ entry.detail ?? '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Mobile: card list -->
    <div v-else class="space-y-2">
      <button
        v-for="entry in entries"
        :key="`m-${entry.t}-${entry.action}`"
        type="button"
        data-testid="audit-row"
        class="w-full text-left bg-surface border border-border-subtle rounded-lg p-3
               hover:bg-surface-2/60 focus-visible:bg-surface-2/60
               focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        @click="emit('open', entry)"
      >
        <div class="flex items-center justify-between gap-2">
          <span
            class="font-mono text-xs text-text-muted tabular-nums"
            data-testid="audit-time"
          >
            {{ formatTime(entry.t) }}
          </span>
          <EventBadge :action="String(entry.action)" />
        </div>
        <div class="mt-2 text-xs text-text-secondary flex items-center gap-3">
          <span v-if="entry.tool" class="font-mono">{{ entry.tool }}</span>
          <span v-if="entry.user">{{ entry.user }}</span>
        </div>
        <p
          v-if="entry.detail"
          class="mt-1.5 text-sm text-text-primary line-clamp-2"
        >
          {{ entry.detail }}
        </p>
      </button>
    </div>

    <!-- Load more (always visible when we have entries) -->
    <div
      v-if="!loading && !isEmpty"
      class="flex items-center justify-between"
    >
      <span class="text-xs text-text-muted">
        {{ visibleCount }} bejegyzés látható
      </span>
      <button
        type="button"
        class="h-8 px-3 rounded-md text-sm text-text-secondary hover:bg-surface-2
               focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        data-testid="load-more-btn"
        @click="emit('loadMore')"
      >
        Több betöltése
      </button>
    </div>

    <!-- Retry (only when loading and an error happened — not modeled
         here directly; this section is for future use if the table
         needs its own error retry button). -->
    <div v-if="false" class="text-right">
      <button
        type="button"
        class="text-xs text-accent"
        data-testid="audit-retry-btn"
        @click="emit('retry')"
      >
        Újra
      </button>
    </div>
  </div>
</template>
