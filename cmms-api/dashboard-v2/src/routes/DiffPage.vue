<script setup lang="ts">
// Diff / Visszaállítás — Phase 9 audit-workspace redesign.
//
// Layout (top to bottom):
//   1. <DiffHeader>           — title + subtitle + one-line explanation
//   2. <DiffControls>         — date/time + presets + load button
//   3. <ComparisonPreview>    — visible only after a diff is loaded
//   4. <DiffSummary>          — visible only after a diff is loaded
//   5. <DiffFilters>          — visible only after a diff is loaded
//   6. <DiffList>             — the result rows
//   7. <DiffDetailPanel>      — right-side inspector (drawer)
//
// Behaviour contract — preserved from the previous implementation so
// the existing test suite (tests/diff.spec.ts) keeps passing:
//
//   - On mount, the diff is NOT loaded. `since` is null and the user
//     sees the empty state.
//   - Clicking a preset computes the `since` ISO, updates the picker
//     input, and immediately triggers the query.
//   - Clicking "Diff betöltése" with a custom picker value loads it
//     as UTC ISO.
//   - Errors render <ErrorState> with a Retry button.
//   - Zero changes render an EmptyState with a "broaden the range"
//     action that loads `ALL_TIME_ISO`.
//
// What's new in Phase 9:
//   - A compact comparison preview that names the baseline + the now
//     endpoints in Hungarian so the operator never has to infer the
//     window from a date picker.
//   - A summary of the change categories that only uses real counts.
//   - A filter row to narrow by category.
//   - A right-side detail panel with the comparison range, both
//     before/after values, and a clearly framed "restore" action that
//     is *not* enabled today (the /api/diff stub doesn't mark anything
//     restorable). The structure is in place so a future server-side
//     restore can be wired in without redesigning the page.
//   - Better empty / loading / error states with the audit-workflow
//     framing.
//   - Mobile: stack controls, scrollable presets, inspector as
//     bottom sheet.

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { humanizeError } from '@/lib/errors'
import {
  ALL_TIME_ISO,
  DIFF_TIMEZONE_LABEL,
  formatHuDateTime,
  isoToPickerValue,
  pickerValueToIso,
  presetToIso,
} from '@/lib/diff'
import type { DiffPreset } from '@/lib/diff'
import type { DiffChange, EvidenceTicket } from '@/lib/api'

import Badge from '@/components/Badge.vue'
import Button from '@/components/Button.vue'
import ComparisonPreview from '@/components/ComparisonPreview.vue'
import DiffControls from '@/components/DiffControls.vue'
import DiffDetailPanel from '@/components/DiffDetailPanel.vue'
import DiffFilters from '@/components/DiffFilters.vue'
import DiffHeader from '@/components/DiffHeader.vue'
import DiffItem from '@/components/DiffItem.vue'
import DiffList from '@/components/DiffList.vue'
import DiffSummary from '@/components/DiffSummary.vue'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'
import RestoreConfirmationDialog from '@/components/RestoreConfirmationDialog.vue'
import Skeleton from '@/components/Skeleton.vue'
import TicketInspector from '@/components/TicketInspector.vue'

// ---------------------------------------------------------------------------
// Picker + preset state
// ---------------------------------------------------------------------------

const pickerValue = ref('')
const since = ref<string | null>(null)
const activePreset = ref<DiffPreset | null>(null)

// `fetchedAt` is the ISO string captured at the moment the diff was
// successfully returned. The "now" endpoint in the comparison preview
// and the detail panel pin to this value so the window doesn't slide
// while the operator is reading the result.
const fetchedAt = ref<string | null>(null)
const lastErrorTitle = ref<string | null>(null)

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const { data, isPending, isFetching, error, refetch, dataUpdatedAt } = useQuery({
  queryKey: ['diff', since],
  queryFn: withAutoRetry(() => useApi().diff(since.value!)),
  enabled: () => since.value !== null,
})

const changes = computed<DiffChange[]>(() => data.value?.changes ?? [])
const humanized = computed(() => (error.value ? humanizeError(error.value) : null))

// Track successful fetches so we can pin the "now" endpoint in the
// preview + detail panel.
watch(data, (v) => {
  if (v) {
    fetchedAt.value = new Date(dataUpdatedAt.value || Date.now()).toISOString()
  }
})
watch(error, (e) => {
  if (e) lastErrorTitle.value = humanizeError(e).title
})

// ---------------------------------------------------------------------------
// Preset + load handlers
// ---------------------------------------------------------------------------

function applyPreset(preset: DiffPreset) {
  const iso = presetToIso(preset)
  pickerValue.value = isoToPickerValue(iso)
  activePreset.value = preset
  since.value = iso
}

function loadDiff() {
  activePreset.value = null
  since.value =
    pickerValue.value === '' ? ALL_TIME_ISO : pickerValueToIso(pickerValue.value)
}

function broadenRange() {
  pickerValue.value = ''
  activePreset.value = 'all'
  since.value = ALL_TIME_ISO
}

// Keep the picker in sync if `since` is set by something other than
// the picker (e.g. by a preset chip).
watch(since, (v) => {
  if (v && v !== ALL_TIME_ISO) {
    const pv = isoToPickerValue(v)
    if (pv && pv !== pickerValue.value) pickerValue.value = pv
  }
})

// ---------------------------------------------------------------------------
// Filter + selection
// ---------------------------------------------------------------------------

const filter = ref<'all' | 'added' | 'modified' | 'deleted' | 'other'>('all')
const selectedId = ref<string | null>(null)
const detailOpen = ref(false)

function onSelect(id: string) {
  if (selectedId.value === id && detailOpen.value) {
    detailOpen.value = false
    return
  }
  selectedId.value = id
  detailOpen.value = true
}

const selectedChange = computed<DiffChange | null>(() => {
  if (!selectedId.value) return null
  return changes.value.find((c) => c.id === selectedId.value) ?? null
})

// ---------------------------------------------------------------------------
// Ticket inspector — opened by "Ticket megnyitása" on a change row
// or the detail panel. We only have the audit row (sorszam-ish id +
// after text) so we synthesise an EvidenceTicket with what we know.
// ---------------------------------------------------------------------------

const inspectorOpen = ref(false)
const inspectorTicket = ref<EvidenceTicket | null>(null)

function viewTicket(id: string) {
  const change = changes.value.find((c) => c.id === id)
  inspectorTicket.value = {
    sorszam: id,
    key: id,
    kategoria: change?.action ?? null,
    kategoria_inferred: null,
    sulyossag_inferred: null,
    reported_at_iso: change?.t ?? '',
    snippet: change
      ? String(change.after ?? `${change.entity} · ${change.action}`)
      : '',
  }
  inspectorOpen.value = true
  detailOpen.value = false
}

// ---------------------------------------------------------------------------
// Restoration (Phase 9: scaffolded, NOT active)
//
// The /api/diff endpoint currently does not mark any change as
// restorable. We compute `restorable` defensively (looking for an
// explicit `restorable: true` discriminator) so the UI does not
// hallucinate a destructive button. The RestoreConfirmationDialog is
// wired into the page but its `open` is always false today; flipping
// it on later is a one-line change in the watch below.
// ---------------------------------------------------------------------------

const restoreOpen = ref(false)
const restoreTarget = ref<DiffChange | null>(null)
const restorePending = ref(false)

function isRestorable(change: DiffChange): boolean {
  // The current wire shape has no restorable discriminator. This
  // function is the *single* place the page decides who is
  // restorable, so a future server-side flag can land here without
  // touching any other file.
  const c = change as DiffChange & { restorable?: boolean }
  return c.restorable === true
}

const restorableCount = computed(
  () => changes.value.filter(isRestorable).length,
)

function onRestoreRequest(id: string) {
  const target = changes.value.find((c) => c.id === id) ?? null
  if (!target || !isRestorable(target)) return
  restoreTarget.value = target
  restoreOpen.value = true
}

function onRestoreCancel() {
  if (restorePending.value) return
  restoreOpen.value = false
  restoreTarget.value = null
}

async function onRestoreConfirm() {
  // No-op: the current API doesn't support mutation. We close the
  // dialog and re-fetch the diff so the operator sees the freshest
  // state. A real implementation would POST to a /v1/jobs/:id/restore
  // (or similar) here, then either refetch or apply the change
  // locally.
  restorePending.value = true
  try {
    await new Promise((r) => setTimeout(r, 0))
  } finally {
    restorePending.value = false
  }
  restoreOpen.value = false
  restoreTarget.value = null
  void refetch()
}

// ---------------------------------------------------------------------------
// Header meta (last successful load)
// ---------------------------------------------------------------------------

const lastLoadedText = computed(() => {
  if (!fetchedAt.value) return null
  return `Utolsó betöltés: ${formatHuDateTime(fetchedAt.value)} ${DIFF_TIMEZONE_LABEL}`
})

// ---------------------------------------------------------------------------
// Loading state: prevent layout flash
// ---------------------------------------------------------------------------

const showLoading = computed(() => since.value !== null && isPending.value)

// Keep scroll position when the result list re-renders after a
// load — small touch but it stops the inspector from yanking the
// viewport around.
const resultsRef = ref<HTMLElement | null>(null)
let lastScrollY = 0
watch(showLoading, async (v) => {
  if (typeof window === 'undefined') return
  if (v) {
    lastScrollY = window.scrollY
  } else {
    await nextTick()
    if (window.scrollY === 0 && lastScrollY > 0) {
      window.scrollTo({ top: lastScrollY, behavior: 'auto' })
    }
  }
})

// Keyboard escape closes the detail panel (ResponsiveDrawer already
// does this, but the watcher below makes sure we also clear the
// selectedId so a re-open of the same row still works).
watch(detailOpen, (open) => {
  if (!open) selectedId.value = null
})

onBeforeUnmount(() => {
  // nothing yet — placeholder for future per-instance cleanup.
})
</script>

<template>
  <div class="h-full flex flex-col" data-testid="diff-page">
    <DiffHeader :meta="lastLoadedText" />

    <DiffControls
      v-model:pickerValue="pickerValue"
      v-model:activePreset="activePreset"
      :loading="isFetching"
      @preset="applyPreset"
      @load="loadDiff"
    />

    <!-- Idle: nothing has been loaded yet. -->
    <div
      v-if="since === null"
      class="flex-1 min-h-0 overflow-y-auto"
      data-testid="diff-idle"
    >
      <div class="max-w-[1200px] mx-auto px-4 md:px-6 py-10">
        <div
          class="rounded-lg border border-border-subtle bg-surface/50 p-6 md:p-10"
          data-testid="diff-idle-card"
        >
          <div class="flex items-start gap-4">
            <div
              class="shrink-0 w-12 h-12 rounded-full bg-nct-500/15 flex items-center justify-center"
              aria-hidden="true"
            >
              <svg
                class="w-6 h-6 text-nct-soft"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
            </div>
            <div class="min-w-0 flex-1">
              <h2 class="text-base md:text-lg font-semibold text-text-primary">
                Nincs betöltött összehasonlítás
              </h2>
              <p class="mt-1 text-[13px] text-text-secondary leading-relaxed max-w-2xl">
                Válassz egy időpontot fent, majd töltsd be a változásokat a korábbi
                és a jelenlegi állapot összevetéséhez.
              </p>
            </div>
          </div>

          <ol class="mt-6 grid gap-3 sm:grid-cols-3">
            <li
              class="rounded-md border border-border-subtle bg-canvas-2/40 p-3"
              data-testid="diff-idle-step-1"
            >
              <p class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
                1 · Korábbi állapot
              </p>
              <p class="mt-1 text-[13px] text-text-primary">
                Válassz egy időpontot, vagy használj egy gyors presetet (1 óra, 24 óra, 7 nap, 30 nap, Mind).
              </p>
            </li>
            <li
              class="rounded-md border border-border-subtle bg-canvas-2/40 p-3"
              data-testid="diff-idle-step-2"
            >
              <p class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
                2 · Diff betöltése
              </p>
              <p class="mt-1 text-[13px] text-text-primary">
                A rendszer összeveti a korábbi és a jelenlegi állapotot.
              </p>
            </li>
            <li
              class="rounded-md border border-border-subtle bg-canvas-2/40 p-3"
              data-testid="diff-idle-step-3"
            >
              <p class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
                3 · Változások áttekintése
              </p>
              <p class="mt-1 text-[13px] text-text-primary">
                Szűrj kategória szerint, és nyisd meg a részleteket egy sorra kattintva.
              </p>
            </li>
          </ol>
        </div>
      </div>
    </div>

    <!-- Loaded: comparison preview, summary, filters, list. -->
    <template v-else>
      <ComparisonPreview
        :since="since"
        :now="fetchedAt"
        scope="Strukturális változások (audit log)"
      />

      <DiffSummary
        v-if="!showLoading && !humanized"
        :changes="changes"
        :restorable-count="restorableCount"
      />

      <DiffFilters
        v-if="!showLoading && !humanized && changes.length > 0"
        v-model:selected="filter"
        :changes="changes"
      />

      <!-- Loading -->
      <div
        v-if="showLoading"
        class="flex-1 min-h-0 overflow-y-auto"
        data-testid="diff-loading"
      >
        <div class="max-w-[1200px] mx-auto px-4 md:px-6 py-4 space-y-3">
          <p class="text-[12px] text-text-muted">Diff betöltése…</p>
          <Skeleton v-for="n in 3" :key="n" h="h-20" w="w-full" />
        </div>
      </div>

      <!-- Error -->
      <div
        v-else-if="humanized"
        class="flex-1 min-h-0 overflow-y-auto"
        data-testid="diff-error-region"
      >
        <ErrorState
          severity="error"
          :title="humanized.title"
          :description="humanized.description"
          :retry="() => { void refetch() }"
        />
      </div>

      <!-- Result -->
      <div
        v-else
        ref="resultsRef"
        class="flex-1 min-h-0 overflow-y-auto"
        data-testid="diff-results"
      >
        <div class="max-w-[1200px] mx-auto">
          <DiffList
            v-if="changes.length > 0"
            v-model:filter="filter"
            v-model:selectedId="selectedId"
            :changes="changes"
            @view-ticket="viewTicket"
          />

          <EmptyState
            v-else
            title="Nincs változás ebben az ablakban"
            description="A kiválasztott időponttól kezdve nem volt jóváhagyás vagy answer esemény."
            data-testid="diff-empty"
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

    <!-- Detail inspector -->
    <DiffDetailPanel
      :open="detailOpen"
      :change="selectedChange"
      :restorable="selectedChange ? isRestorable(selectedChange) : false"
      :since="since"
      :now="fetchedAt"
      @update:open="(v) => (detailOpen = v)"
      @view-ticket="viewTicket"
      @restore="onRestoreRequest"
    />

    <!-- Restore confirmation (only mounted, never auto-opened today). -->
    <RestoreConfirmationDialog
      :open="restoreOpen"
      :single="restoreTarget"
      :batch="[]"
      :since="since"
      :pending="restorePending"
      @update:open="(v) => (restoreOpen = v)"
      @cancel="onRestoreCancel"
      @confirm="onRestoreConfirm"
    />

    <!-- Standalone ticket inspector (existing behaviour preserved). -->
    <TicketInspector
      :open="inspectorOpen"
      :ticket="inspectorTicket"
      @update:open="(v) => (inspectorOpen = v)"
    />
  </div>
</template>
