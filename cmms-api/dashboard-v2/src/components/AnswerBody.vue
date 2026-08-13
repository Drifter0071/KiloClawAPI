<script setup lang="ts">
// src/components/AnswerBody.vue
//
// Renders one AnswerResponse via the typed view from lib/renderAnswer.ts.
// Used by AskPage and the Stream page's answer section. Never renders
// raw JSON.
//
// The component owns the body of the response (badges, summary, results,
// follow-ups, candidate list). The evidence display is the caller's
// responsibility — AskPage renders a horizontal card row + inspector,
// StreamPage just shows the question/summary.
//
// Emits:
//   run(view)      — confirm-mód "Igen, futtasd" (a view-jal együtt)
//   refine()       — confirm-mód "Nem, pontosítsd"
//   followup(text) — egy follow-up chipre kattintottak

import { computed } from 'vue'
import Badge from '@/components/Badge.vue'
import Button from '@/components/Button.vue'
import { renderAnswer } from '@/lib/renderAnswer'
import type { AnswerResponse } from '@/lib/api'

defineProps<{
  data: AnswerResponse
}>()

const emit = defineEmits<{
  (e: 'run', view: ReturnType<typeof renderAnswer>): void
  (e: 'refine'): void
  (e: 'followup', text: string): void
}>()

const FAMILY_LABELS: Record<string, string> = {
  customer: 'További ügyfél-csoportosítások',
  time: 'További időablakos értelmezések',
  recurring: 'További visszatérő-minták',
  integration: 'További integrációs értelmezések',
  other: 'Egyéb értelmezések',
}

const CONFIDENCE_LABEL_HU: Record<'high' | 'med' | 'low', string> = {
  high: 'magas',
  med: 'közepes',
  low: 'alacsony',
}

function scoreClass(pct: number): string {
  if (pct >= 60) return 'text-success'
  if (pct >= 40) return 'text-warning'
  return 'text-danger'
}

const confidenceClass = (label: 'high' | 'med' | 'low') =>
  label === 'high'
    ? 'bg-success/15 text-success'
    : label === 'med'
      ? 'bg-warning/15 text-warning'
      : 'bg-danger/15 text-danger'
</script>

<template>
  <!-- CONFIRM MODE -->
  <div v-if="renderAnswer(data).mode === 'confirm'" data-testid="confirm-prompt">
    <p class="text-[15px] leading-relaxed text-text-primary">
      Azt hiszem, erre gondoltál:
      <em class="text-text-secondary">
        {{ renderAnswer(data).confirmSummary ?? renderAnswer(data).intent }}
      </em>
      — jó?
    </p>
    <div class="flex gap-2 mt-3">
      <Button size="md" data-testid="confirm-yes" @click="emit('run', renderAnswer(data))">
        Igen, futtasd
      </Button>
      <Button variant="ghost" size="md" data-testid="confirm-no" @click="emit('refine')">
        Nem, pontosítsd
      </Button>
    </div>
  </div>

  <!-- ANSWER MODE -->
  <div v-else>
    <!-- header: badges + confidence pill -->
    <div class="flex items-center justify-between gap-2 mb-2">
      <div class="flex items-center gap-2 min-w-0">
        <Badge variant="info" :label="renderAnswer(data).intent" />
        <Badge variant="default" :label="renderAnswer(data).primitive" />
      </div>
      <span
        class="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md whitespace-nowrap"
        :class="confidenceClass(renderAnswer(data).confidenceLabel)"
        data-testid="confidence-pill"
      >
        {{ CONFIDENCE_LABEL_HU[renderAnswer(data).confidenceLabel] }}
      </span>
    </div>

    <div class="font-mono text-[11px] text-text-muted mb-1.5 tabular-nums">
      {{ renderAnswer(data).periodLabel }}
    </div>
    <p class="text-[15px] leading-relaxed text-text-primary">{{ renderAnswer(data).summary }}</p>

    <!-- results -->
    <div
      v-if="renderAnswer(data).results.length > 0"
      class="mt-3 divide-y divide-border-subtle/60"
    >
      <div
        v-for="row in renderAnswer(data).results.slice(0, 8)"
        :key="row.sorszam ?? row.primary"
        class="py-1.5 first:pt-0"
        data-testid="result-row"
      >
        <div class="flex items-baseline gap-2 min-w-0">
          <span v-if="row.sorszam" class="font-mono text-[12px] text-accent shrink-0">
            {{ row.sorszam }}
          </span>
          <span class="text-[13px] text-text-primary truncate">{{ row.primary }}</span>
          <span v-if="row.secondary" class="text-[11px] text-text-muted shrink-0">
            {{ row.secondary }}
          </span>
        </div>
        <div
          v-if="row.meta.length > 0"
          class="text-[11px] font-mono text-text-muted mt-0.5 truncate"
        >
          {{ row.meta.map(([k, v]) => `${k}: ${v}`).join(' · ') }}
        </div>
      </div>
    </div>

    <!-- follow-up chips -->
    <div
      v-if="renderAnswer(data).followUps.length > 0"
      class="flex flex-wrap gap-2 mt-3"
    >
      <button
        v-for="f in renderAnswer(data).followUps"
        :key="f"
        type="button"
        class="px-2.5 h-7 rounded-md bg-accent/10 text-accent hover:bg-accent/20 text-[12px] transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        data-testid="followup-chip"
        @click="emit('followup', f)"
      >
        {{ f }}
      </button>
    </div>

    <!-- other interpretations -->
    <details
      v-if="renderAnswer(data).candidates.filter((c) => c.rank > 1).length > 0"
      class="mt-3"
      data-testid="candidates-expander"
    >
      <summary
        class="cursor-pointer text-[11px] font-mono uppercase tracking-wider text-text-muted hover:text-text-secondary"
      >
        Egyéb értelmezések ({{ renderAnswer(data).candidates.filter((c) => c.rank > 1).length }})
      </summary>
      <div class="mt-2 space-y-1.5">
        <template
          v-for="(c, i) in renderAnswer(data).candidates.filter((c) => c.rank > 1)"
          :key="c.rank"
        >
          <div
            v-if="i === 0 || c.family !== renderAnswer(data).candidates.filter((x) => x.rank > 1)[i - 1]?.family"
            class="text-[11px] text-text-muted mt-2 first:mt-0"
          >
            {{ FAMILY_LABELS[c.family] ?? c.family }}
          </div>
          <div class="flex items-baseline gap-2 text-[13px] min-w-0">
            <span class="font-mono text-[11px] text-text-primary shrink-0">{{ c.intent }}</span>
            <span class="text-[11px] text-text-muted shrink-0">{{ c.primitive }}</span>
            <span
              class="font-mono text-[11px] tabular-nums shrink-0"
              :class="scoreClass(parseInt(c.scorePct, 10))"
            >
              {{ c.scorePct }}
            </span>
            <span class="text-[12px] text-text-secondary truncate">{{ c.summary }}</span>
          </div>
        </template>
      </div>
    </details>
  </div>
</template>
