<script setup lang="ts">
// Diff / Revert — spec §5.4.
//
// v1 ships the page as a *structured change log*: the server stub
// (/dashboard/api/diff, server.ts:424-440) filters the in-memory audit
// log by action ∈ {approval, answer} and wraps each row as
// { changes: [{ entity, id, action, t, before: null, after: string }] }.
// There is no real line-level diff — each row renders the `after` text
// in monospace, with an action badge and a "View ticket →" link that
// seeds the Ask page. Nothing is revertable in v1, so the Revert affordance
// is muted text only.

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

// ---------------------------------------------------------------------------
// State — the "Since" window. Nothing is queried until the operator
// submits via a preset chip or "Load diff" (spec §5.4 submit model).
// ---------------------------------------------------------------------------

/** Raw `<input type="datetime-local">` value ('' = all time). */
const pickerValue = ref('')

/** The submitted window, as UTC ISO. `null` = never submitted yet. */
const since = ref<string | null>(null)

const { data, isFetching, error, refetch } = useQuery({
  queryKey: ['diff', since],
  queryFn: withAutoRetry(() => useApi().diff(since.value!)),
  enabled: () => since.value !== null,
})

const changes = computed(() => data.value?.changes ?? [])
const humanized = computed(() => (error.value ? humanizeError(error.value) : null))

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Preset chip: sync the picker to now-duration and submit immediately. */
function applyPreset(preset: DiffPreset) {
  const iso = presetToIso(preset)
  pickerValue.value = isoToPickerValue(iso)
  since.value = iso
}

/** "Load diff": submit whatever the picker holds (empty → all time). */
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

/** e.g. '2026-08-12 14:30:22'. Server emits UTC ISO (`new Date().toISOString()`
 *  in pushAudit, server.ts:152), so we render the UTC wall-clock parts. */
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
    <!-- Title row -->
    <div
      class="h-12 px-6 flex items-center justify-between border-b border-border-subtle shrink-0"
    >
      <div class="flex flex-col justify-center">
        <div class="text-md font-semibold text-text-primary">Diff / Visszaállítás</div>
        <div class="text-xs text-text-muted">
          Strukturált változásnapló · audit-alapú (v1-ben nincs sor-szint diff)
        </div>
      </div>
    </div>

    <!-- Control bar -->
    <div
      class="px-6 py-4 border-b border-border-subtle flex items-center gap-3 shrink-0"
    >
      <label
        for="diff-since"
        class="text-xs text-text-muted font-medium"
      >
        Ettl kezdve
      </label>
      <input
        id="diff-since"
        v-model="pickerValue"
        type="datetime-local"
        class="h-9 px-3 rounded-md bg-surface border border-border-default font-mono text-sm text-text-primary focus:border-accent focus:outline-none"
        data-testid="since-input"
      />
      <div class="flex items-center gap-2">
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
        :loading="isFetching"
        :disabled="isFetching"
        data-testid="load-diff"
        @click="loadDiff"
      >
        Diff betöltése
      </Button>
    </div>

    <!-- Change list / loading / empty / error -->
    <div class="flex-1 overflow-y-auto">
      <EmptyState
        v-if="since === null"
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
            Idablak kiterjesztése
          </Button>
        </template>
      </EmptyState>

      <div
        v-else-if="isFetching"
        data-testid="diff-loading"
      >
        <div
          v-for="n in 3"
          :key="n"
          class="px-6 py-4 border-b border-border-subtle"
        >
          <Skeleton h="h-24" w="w-full" />
        </div>
      </div>

      <ErrorState
        v-else-if="humanized"
        severity="error"
        :title="humanized.title"
        :description="humanized.description"
        :retry="() => { void refetch() }"
      />

      <div
        v-else-if="changes.length > 0"
        data-testid="diff-list"
      >
        <div
          v-for="change in changes"
          :key="`${change.t}-${change.action}`"
          class="border-b border-border-subtle px-6 py-4"
          data-testid="diff-entry"
        >
          <div class="flex items-center gap-3">
            <span class="w-44 shrink-0 font-mono text-xs text-text-muted">
              {{ formatTimestamp(change.t) }}
            </span>
            <Badge
              data-testid="diff-action-badge"
              :variant="badgeVariant(change.action)"
              :label="change.action"
            />
            <span class="text-xs font-mono text-text-secondary">
              {{ change.entity }}
            </span>
            <span class="font-mono text-xs text-accent">
              {{ change.id }}
            </span>
          </div>
          <DiffBlock class="mt-3" :after="String(change.after)" />
          <div class="mt-3 flex items-center justify-between">
            <span class="text-xs text-text-muted">
              Visszaállítás elérhet az API-n keresztül
            </span>
            <button
              type="button"
              class="text-xs text-accent hover:text-accent-hover"
              data-testid="view-ticket"
              @click="viewTicket(change.id)"
            >
              Ticket megnyitása →
            </button>
          </div>
        </div>
      </div>

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
            Idablak kiterjesztése
          </Button>
        </template>
      </EmptyState>
    </div>
  </div>
</template>
