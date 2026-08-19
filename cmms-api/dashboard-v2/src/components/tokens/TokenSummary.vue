<script setup lang="ts">
// src/components/tokens/TokenSummary.vue
//
// Phase 5.5 — compact 4-tile security summary. Real data only:
// derives from the audit log + tokens query. No mock values, no
// fake status metrics.

import { computed } from 'vue'
import type { AuditEntry } from '@/lib/api'
import Skeleton from '@/components/Skeleton.vue'

const props = defineProps<{
  /** Audit entries (already loaded). */
  entries: AuditEntry[]
  /** Whether the audit query is still loading. */
  loading: boolean
  /** Whether the token prefixes are loaded. */
  tokensLoaded: boolean
  /** Number of token prefixes the backend actually returned. */
  tokenCount: number
}>()

interface Tile {
  label: string
  value: string
  tone: 'success' | 'warn' | 'danger' | 'neutral'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** ISO -> 'YYYY.MM.DD' in local time. */
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`
}

const tiles = computed<Tile[]>(() => {
  if (props.loading) return []

  const last = props.entries[0]?.t
  const failureCount = props.entries.filter((e) => {
    const a = e.action
    return a === 'login_failed' || a === 'revert_request'
  }).length

  return [
    {
      label: 'Aktív tokenek',
      value: props.tokensLoaded ? String(props.tokenCount) : '—',
      tone: 'neutral',
    },
    {
      label: 'Utolsó esemény',
      value: last ? formatDate(last) : '—',
      tone: 'neutral',
    },
    {
      label: 'Sikertelen események',
      value: String(failureCount),
      tone:
        failureCount === 0
          ? 'success'
          : failureCount > 3
            ? 'danger'
            : 'warn',
    },
    {
      label: 'Audit bejegyzések',
      value: String(props.entries.length),
      tone: 'neutral',
    },
  ]
})

const toneClasses: Record<Tile['tone'], string> = {
  success: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  danger: 'text-rose-700 dark:text-rose-300',
  neutral: 'text-text-primary',
}
</script>

<template>
  <section
    data-testid="token-summary"
    class="grid grid-cols-2 md:grid-cols-4 gap-3"
    aria-label="Tokenek biztonsági összefoglaló"
  >
    <template v-if="loading">
      <div
        v-for="i in 4"
        :key="i"
        class="bg-surface border border-border-subtle rounded-lg p-3"
      >
        <Skeleton h="h-3" w="w-20" />
        <div class="mt-2"><Skeleton h="h-5" w="w-12" /></div>
      </div>
    </template>
    <template v-else>
      <div
        v-for="tile in tiles"
        :key="tile.label"
        class="bg-surface border border-border-subtle rounded-lg p-3"
        :data-testid="`summary-tile-${tile.label}`"
      >
        <div class="text-[11px] uppercase tracking-wider text-text-muted">
          {{ tile.label }}
        </div>
        <div
          class="mt-1 text-lg font-semibold tabular-nums"
          :class="toneClasses[tile.tone]"
        >
          {{ tile.value }}
        </div>
      </div>
    </template>
  </section>
</template>
