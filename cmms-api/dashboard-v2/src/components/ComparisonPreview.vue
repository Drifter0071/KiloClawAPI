<script setup lang="ts">
// src/components/ComparisonPreview.vue
//
// Compact "what is being compared" card that sits between the
// controls and the results. Renders the resolved baseline + the
// "now" endpoint in plain Hungarian so the operator never has to
// infer the comparison window from a date picker.
//
// Parent owns the `since` / `now` ISO strings. The component is NOT
// rendered before a diff is loaded; the empty state and the
// controls already cover the pre-load case.
import { computed } from 'vue'
import {
  DIFF_TIMEZONE_LABEL,
  formatHuDateTime,
  formatHuDateTimeWithZone,
} from '@/lib/diff'

const props = defineProps<{
  /** Baseline ISO timestamp (the "korábbi állapot"). */
  since: string | null
  /** The "current" endpoint. Defaults to `new Date()` on mount but the
   *  parent can pin it to the `dataUpdatedAt` of the last fetch so
   *  the "jelenlegi állapot" matches the moment the diff was actually
   *  taken. */
  now: string | null
  /** Optional scope label, e.g. "Strukturális változások (audit log)". */
  scope?: string | null
}>()

const baselineText = computed(() =>
  props.since ? formatHuDateTimeWithZone(props.since) : '—',
)
const nowText = computed(() => {
  if (props.now) return formatHuDateTimeWithZone(props.now)
  return formatHuDateTimeWithZone(new Date())
})
const zone = computed(() => DIFF_TIMEZONE_LABEL)
const sinceEpoch = computed(() => (props.since ? Date.parse(props.since) : null))
const nowEpoch = computed(() => (props.now ? Date.parse(props.now) : Date.now()))
const windowText = computed(() => {
  if (sinceEpoch.value === null) return null
  const ms = Math.max(0, nowEpoch.value - sinceEpoch.value)
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'kevesebb mint 1 perc'
  if (min < 60) return `${min} perc`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} óra`
  const d = Math.floor(h / 24)
  return `${d} nap`
})
</script>

<template>
  <section
    class="px-4 md:px-6 py-3 border-b border-border-subtle bg-canvas-2/30"
    aria-labelledby="comparison-preview-heading"
    data-testid="comparison-preview"
  >
    <div class="max-w-[1200px] grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
      <div class="min-w-0">
        <h2
          id="comparison-preview-heading"
          class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5"
        >
          Összehasonlítás
        </h2>
        <p class="text-[13px] text-text-primary leading-relaxed">
          <span class="font-mono">{{ baselineText }}</span>
          <span class="mx-2 text-text-muted" aria-hidden="true">→</span>
          <span class="font-mono">{{ nowText }}</span>
          <span class="ml-1 text-text-muted">({{ zone }})</span>
        </p>
        <p v-if="windowText" class="mt-0.5 text-[12px] text-text-muted">
          Időablak hossza: <span class="font-mono">{{ windowText }}</span>
          <span v-if="scope"> · {{ scope }}</span>
        </p>
      </div>
      <div class="hidden md:flex flex-col items-end text-[11px] text-text-muted font-mono">
        <span>Korábbi állapot · {{ zone }}</span>
        <span>Jelenlegi állapot · {{ zone }}</span>
      </div>
    </div>
  </section>
</template>
