<script setup lang="ts">
// src/components/tokens/TokenList.vue
//
// Phase 5.5 — token metadata panel. Masked 8-char prefixes only.
// Server returns 8-char prefixes; we render them as-is and never
// fetch full values.

import type { TokensResponse } from '@/lib/api'
import Skeleton from '@/components/Skeleton.vue'

const props = defineProps<{
  tokens: TokensResponse | undefined
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'copy', value: { key: 'read' | 'write' | 'bearer'; value: string }): void
}>()

interface Row {
  key: 'read' | 'write' | 'bearer'
  label: string
  hint: string
  value: string
}

const COPY_ARIA: Record<Row['key'], string> = {
  read: 'Read token másolása',
  write: 'Write token másolása',
  bearer: 'Bearer token másolása',
}

const rows: Row[] = [
  {
    key: 'read',
    label: 'Read',
    hint: 'CMMS_API_TOKEN_READ — csak olvasás',
    value: '',
  },
  {
    key: 'write',
    label: 'Write',
    hint: 'CMMS_API_TOKEN_WRITE — módosítás',
    value: '',
  },
  {
    key: 'bearer',
    label: 'Bearer',
    hint: 'MCP bearer — agent bridge',
    value: '',
  },
]

function valueFor(key: Row['key']): string {
  if (!props.tokens) return '…'
  if (key === 'read') return props.tokens.read_token_prefix
  if (key === 'write') return props.tokens.write_token_prefix
  return props.tokens.bearer_token_prefix
}
</script>

<template>
  <section
    data-testid="token-list"
    class="bg-surface border border-border-subtle rounded-lg overflow-hidden"
  >
    <header class="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
      <div>
        <h2 class="text-sm font-semibold text-text-primary">Tokenek kezelése</h2>
        <p class="text-xs text-text-muted mt-0.5">
          Csak az első 8 karakter — a teljes értékek soha nem hagyják el a szervert.
        </p>
      </div>
    </header>

    <div class="divide-y divide-border-subtle">
      <!-- Loading: 3 skeleton rows -->
      <template v-if="loading">
        <div v-for="i in 3" :key="i" class="px-4 py-3 flex items-center gap-3">
          <Skeleton h="h-3" w="w-14" />
          <Skeleton h="h-3" w="w-40" />
          <Skeleton h="h-3" w="w-24" />
        </div>
      </template>

      <template v-else>
        <div
          v-for="row in rows"
          :key="row.key"
          class="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2"
          data-testid="token-list-row"
        >
          <span class="w-16 text-xs text-text-muted shrink-0">{{ row.label }}</span>
          <span
            class="font-mono text-sm text-text-primary"
            :data-testid="`token-list-value-${row.key}`"
          >
            {{ valueFor(row.key) }}
          </span>
          <span class="text-xs text-text-muted">{{ row.hint }}</span>
          <button
            type="button"
            class="ml-auto text-xs text-accent hover:text-accent-hover
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                   rounded px-2 py-1"
            :data-testid="`token-list-copy-${row.key}`"
            :aria-label="COPY_ARIA[row.key]"
            @click="emit('copy', { key: row.key, value: valueFor(row.key) })"
          >
            Másol
          </button>
        </div>
      </template>
    </div>
  </section>
</template>
