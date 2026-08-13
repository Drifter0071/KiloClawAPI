<script setup lang="ts">
// src/components/AnswerBody.vue
//
// Renders one AnswerResponse via the typed view from lib/renderAnswer.ts.
// Used by AskPage (full body) and the Stream page's answer section. Never
// renders raw JSON.
//
// Modes:
//   - confirm → "Azt hiszem, X-re gondoltál — jó?" + Igen/Nem
//   - answer  → bizonytalanság-pill + intent/primitive jelvények + összefoglaló +
//               találatok + follow-up chipek + "Egyéb értelmezések" +
//               inline evidencia-akkordeon (keskeny képernyőn; az Ask oldal
//               >=1024px-en w-80 evidencia-sínt renderel helyette).
//
// Emits: run(view)      — confirm-mód "Igen, futtasd" (a view-jal együtt)
//        refine()       — confirm-mód "Nem, pontosítsd"
//        followup(text) — egy follow-up chipre kattintottak

import { computed } from 'vue'
import Badge from '@/components/Badge.vue'
import Button from '@/components/Button.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { renderAnswer, type ResultRow } from '@/lib/renderAnswer'
import type { AnswerResponse } from '@/lib/api'

const props = defineProps<{
  data: AnswerResponse
}>()

const emit = defineEmits<{
  (e: 'run', view: ReturnType<typeof renderAnswer>): void
  (e: 'refine'): void
  (e: 'followup', text: string): void
}>()

const wide = useMediaQuery('(min-width: 1024px)')

const view = computed(() => renderAnswer(props.data))

const FAMILY_LABELS: Record<string, string> = {
  customer: 'További ügyfél-csoportosítások',
  time: 'További időablakos értelmezések',
  recurring: 'További visszatérő-minták',
  integration: 'További integrációs értelmezések',
  other: 'Egyéb értelmezések',
}

/** Confidence-label → magyar címke (a wire `confidenceLabel` értéke megmarad). */
const CONFIDENCE_LABEL_HU: Record<'high' | 'med' | 'low', string> = {
  high: 'magas',
  med: 'közepes',
  low: 'alacsony',
}

const confidenceLabelHu = computed(() => CONFIDENCE_LABEL_HU[view.value.confidenceLabel])

function scoreClass(pct: number): string {
  if (pct >= 60) return 'text-success'
  if (pct >= 40) return 'text-warning'
  return 'text-danger'
}
</script>

<template>
  <!-- CONFIRM MODE -->
  <div v-if="view.mode === 'confirm'" data-testid="confirm-prompt">
    <p class="text-md text-text-primary">
      Azt hiszem, erre gondoltál:
      <em class="text-text-secondary">{{ view.confirmSummary ?? view.intent }}</em>
      — jó?
    </p>
    <div class="flex gap-2 mt-3">
      <Button size="md" data-testid="confirm-yes" @click="emit('run', view)">Igen, futtasd</Button>
      <Button variant="ghost" size="md" data-testid="confirm-no" @click="emit('refine')">Nem, pontosítsd</Button>
    </div>
  </div>

  <!-- ANSWER MODE -->
  <div v-else>
    <!-- header: badges + confidence pill -->
    <div class="flex items-center justify-between gap-2 mb-2">
      <div class="flex items-center gap-2 min-w-0">
        <Badge variant="info" :label="view.intent" />
        <Badge variant="default" :label="view.primitive" />
      </div>
      <span
        class="font-mono text-[10px] uppercase px-2 py-0.5 rounded-full whitespace-nowrap"
        :class="
          view.confidenceLabel === 'high'
            ? 'bg-success/15 text-success'
            : view.confidenceLabel === 'med'
              ? 'bg-warning/15 text-warning'
              : 'bg-danger/15 text-danger'
        "
        data-testid="confidence-pill"
      >
        {{ confidenceLabelHu }}
      </span>
    </div>

    <div class="font-mono text-xs text-text-muted mb-1">{{ view.periodLabel }}</div>
    <p class="text-md text-text-primary">{{ view.summary }}</p>

    <!-- results -->
    <div v-if="view.results.length > 0" class="mt-3 space-y-0">
      <div
        v-for="row in view.results.slice(0, 8)"
        :key="row.sorszam ?? row.primary"
        class="py-1.5 border-b border-border-subtle/60 last:border-0"
        data-testid="result-row"
      >
        <div class="flex items-baseline gap-2">
          <span v-if="row.sorszam" class="font-mono text-sm text-accent">{{ row.sorszam }}</span>
          <span class="text-sm text-text-primary">{{ row.primary }}</span>
          <span v-if="row.secondary" class="text-xs text-text-muted">{{ row.secondary }}</span>
        </div>
        <div v-if="row.meta.length > 0" class="text-[11px] font-mono text-text-muted mt-0.5">
          {{ row.meta.map(([k, v]) => `${k}: ${v}`).join(' · ') }}
        </div>
      </div>
    </div>

    <!-- follow-up chips -->
    <div v-if="view.followUps.length > 0" class="flex flex-wrap gap-2 mt-3">
      <button
        v-for="f in view.followUps"
        :key="f"
        type="button"
        class="px-2.5 h-6 rounded-full bg-accent/15 text-accent hover:bg-accent/25 text-xs transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        data-testid="followup-chip"
        @click="emit('followup', f)"
      >
        {{ f }}
      </button>
    </div>

    <!-- other interpretations -->
    <details v-if="view.candidates.filter((c) => c.rank > 1).length > 0" class="mt-3" data-testid="candidates-expander">
      <summary class="cursor-pointer text-xs font-mono uppercase tracking-wider text-text-muted hover:text-text-secondary">
        Egyéb értelmezések ({{ view.candidates.filter((c) => c.rank > 1).length }})
      </summary>
      <div class="mt-2 space-y-2">
        <template v-for="(c, i) in view.candidates.filter((c) => c.rank > 1)" :key="c.rank">
          <div
            v-if="i === 0 || c.family !== view.candidates.filter((x) => x.rank > 1)[i - 1]?.family"
            class="text-xs text-text-muted mt-3 first:mt-0"
          >
            {{ FAMILY_LABELS[c.family] ?? c.family }}
          </div>
          <div class="flex items-baseline gap-2 text-sm">
            <span class="font-mono text-xs text-text-primary">{{ c.intent }}</span>
            <span class="text-xs text-text-muted">{{ c.primitive }}</span>
            <span class="font-mono text-[11px]" :class="scoreClass(parseInt(c.scorePct, 10))">{{ c.scorePct }}</span>
            <span class="text-xs text-text-secondary">{{ c.summary }}</span>
          </div>
        </template>
      </div>
    </details>

    <!-- inline evidence accordion (narrow screens only; Ask renders a rail on wide) -->
    <details
      v-if="!wide && view.evidence.length > 0"
      class="mt-3"
      data-testid="evidence-accordion"
    >
      <summary class="cursor-pointer text-xs font-mono uppercase tracking-wider text-text-muted hover:text-text-secondary">
        Evidencia ({{ view.evidence.reduce((n, g) => n + g.tickets.length, 0) }})
      </summary>
      <div class="mt-2 space-y-3">
        <div v-for="group in view.evidence" :key="group.label">
          <div class="text-xs font-medium text-text-secondary uppercase tracking-wider">{{ group.label }}</div>
          <div v-for="t in group.tickets" :key="t.sorszam" class="mt-1">
            <span class="font-mono text-xs text-accent/90">{{ t.sorszam }}</span>
            <span class="text-xs text-text-muted ml-2">{{ t.snippet }}</span>
          </div>
        </div>
      </div>
    </details>
  </div>
</template>
