<script setup lang="ts">
// Diff / Visszaállítás — Phase 7 HIG.
//
// Structured form row for the "Since" picker, the preset chips and the
// submit button. Each sits in its own labelled cell of a 1-row grid so
// the form reads left-to-right naturally, even on mobile (wraps to 2
// rows). Change rows below the toolbar are dense structured records
// with monospace metadata + a monospace block of `after` text.

import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { setSeedQ } from '@/composables/useSeedQ'
import { humanizeError } from '@/lib/errors'
import {
  ALL_TIME_ISO,
  DIFF_PRESETS,
  isoToPickerValue,
  pickerValueToIso,
  presetToIso,
} from '@/lib/diff'
import type { DiffPreset } from '@/lib/diff'
import Badge from '@/components/Badge.vue'
import Button from '@/components/Button.vue'
import DiffBlock from '@/components/DiffBlock.vue'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'
import Skeleton from '@/components/Skeleton.vue'

const pickerValue = ref('')
const since = ref<string | null>(null)

const { data, isFetching, error, refetch } = useQuery({
  queryKey: ['diff', since],
  queryFn: withAutoRetry(() => useApi().diff(since.value!)),
  enabled: () => since.value !== null,
})

const changes = computed(() => data.value?.changes ?? [])
const humanized = computed(() => (error.value ? humanizeError(error.value) : null))

function applyPreset(preset: DiffPreset) {
  const iso = presetToIso(preset)
  pickerValue.value = isoToPickerValue(iso)
  since.value = iso
}

function loadDiff() {
  since.value =
    pickerValue.value === '' ? ALL_TIME_ISO : pickerValueToIso(pickerValue.value)
}

function broadenRange() {
  since.value = ALL_TIME_ISO
}

function viewTicket(id: string) {
  setSeedQ(`ticket ${id}`)
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info'

function badgeVariant(action: string): BadgeVariant {
  if (action === 'approval') return 'warning'
  if (action === 'answer') return 'info'
  return 'default'
}
</script>

<template>
  <div class="h-full flex flex-col" data-testid="diff-page">
    <!-- Page header -->
    <header
      class="h-13 px-4 md:px-6 flex items-center justify-between border-b border-border-subtle bg-canvas-2/60 shrink-0"
    >
      <div class="min-w-0">
        <h1 class="text-[15px] font-semibold tracking-tight text-text-primary leading-none">
          Diff / Visszaállítás
        </h1>
        <p class="text-[12px] text-text-muted mt-1 truncate">
          Strukturált változásnapló · audit-alapú (v1-ben nincs sor-szintű diff)
        </p>
      </div>
    </header>

    <!-- Control bar — HIG form row: label + input + presets + submit.
         On mobile it wraps to two rows but stays left-aligned. -->
    <div
      class="px-4 md:px-6 py-3 border-b border-border-subtle flex flex-wrap items-center gap-3 shrink-0"
      data-testid="diff-controls"
    >
      <div class="flex items-center gap-2">
        <label
          for="diff-since"
          class="text-[11px] font-mono uppercase tracking-wider text-text-muted"
        >
          Ettől kezdve
        </label>
        <input
          id="diff-since"
          v-model="pickerValue"
          type="datetime-local"
          class="h-9 px-3 rounded-md bg-surface border border-border-default font-mono text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 transition-colors duration-150"
          data-testid="since-input"
        />
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <Button
          v-for="preset in DIFF_PRESETS"
          :key="preset.value"
          variant="secondary"
          size="sm"
          :data-testid="`preset-${preset.value}`"
          @click="applyPreset(preset.value)"
        >
          {{ preset.label }}
        </Button>
      </div>
      <Button
        variant="primary"
        size="md"
        class="ml-auto"
        :loading="isFetching"
        :disabled="isFetching"
        data-testid="load-diff"
        @click="loadDiff"
      >
        Diff betöltése
      </Button>
    </div>

    <!-- List -->
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div
        v-if="since === null"
        class="h-full flex flex-col items-center justify-center text-center gap-3 p-6 text-text-muted"
        data-testid="diff-idle"
      >
        <div class="text-[15px] font-medium text-text-primary">
          Válassz időablakot a fenti eszköztárral
        </div>
        <div class="text-sm text-text-muted max-w-md">
          A "Diff betöltése" gombra kattintva megjelennek a kiválasztott
          időszak jóváhagyás és answer eseményei.
        </div>
      </div>

      <div
        v-else-if="isFetching"
        data-testid="diff-loading"
        class="divide-y divide-border-subtle"
      >
        <div v-for="n in 3" :key="n" class="px-4 md:px-6 py-4">
          <Skeleton h="h-20" w="w-full" />
        </div>
      </div>

      <ErrorState
        v-else-if="humanized"
        severity="error"
        :title="humanized.title"
        :description="humanized.description"
        :retry="() => { void refetch() }"
      />

      <ul
        v-else-if="changes.length > 0"
        class="divide-y divide-border-subtle"
        data-testid="diff-list"
      >
        <li
          v-for="change in changes"
          :key="`${change.t}-${change.action}`"
          class="px-4 md:px-6 py-4 max-w-5xl"
          data-testid="diff-entry"
        >
          <div class="flex items-center flex-wrap gap-2 md:gap-3">
            <span class="w-44 shrink-0 font-mono text-[11px] text-text-muted tabular-nums">
              {{ formatTimestamp(change.t) }}
            </span>
            <Badge
              data-testid="diff-action-badge"
              :variant="badgeVariant(change.action)"
              :label="change.action"
            />
            <span class="text-[11px] font-mono text-text-secondary">
              {{ change.entity }}
            </span>
            <span class="font-mono text-[11px] text-accent">
              {{ change.id }}
            </span>
          </div>
          <DiffBlock class="mt-3" :after="String(change.after)" />
          <div class="mt-3 flex items-center justify-between">
            <span class="text-[11px] text-text-muted">
              Visszaállítás elérhető az API-n keresztül
            </span>
            <button
              type="button"
              class="text-[12px] text-accent hover:text-accent-hover"
              data-testid="view-ticket"
              @click="viewTicket(change.id)"
            >
              Ticket megnyitása →
            </button>
          </div>
        </li>
      </ul>

      <EmptyState
        v-else
        title="Nincs változás ebben az ablakban"
        description="A kiválasztott idt kezdve nem volt jóváhagyás vagy answer esemény."
      >
        <template #actions>
          <Button
            variant="secondary"
            size="md"
            data-testid="broaden-range"
            @click="broadenRange"
          >
            Időablak kiterjesztése
          </Button>
        </template>
      </EmptyState>
    </div>
  </div>
</template>
