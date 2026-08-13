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
// Every text field that can carry a sorszam is wrapped in <SorszamLink>
// so a B-sorszam click opens the right-side ticket panel and an
// M-sorszam click routes to /ask with a device query. The component
// re-emits `sorszamClick` upward so AskPage / StreamPage can branch
// on the prefix without each one re-wrapping the text.
//
// Emits:
//   run(view)              — confirm-mód "Igen, futtasd"
//   refine()               — confirm-mód "Nem, pontosítsd"
//   followup(text)         — egy follow-up chipre kattintottak
//   sorszamClick(payload)  — operator tapped a sorszam-shaped token
//                            in any rendered text field.

import { computed } from 'vue'
import Badge from '@/components/Badge.vue'
import Button from '@/components/Button.vue'
import SorszamLink, { type SorszamClickEvent } from '@/components/SorszamLink.vue'
import { renderAnswer } from '@/lib/renderAnswer'
import type { AnswerResponse } from '@/lib/api'

const props = defineProps<{
  data: AnswerResponse
}>()

const emit = defineEmits<{
  (e: 'run', view: ReturnType<typeof renderAnswer>): void
  (e: 'refine'): void
  (e: 'followup', text: string): void
  (e: 'sorszamClick', payload: SorszamClickEvent): void
}>()

const view = computed(() => renderAnswer(props.data))

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
  <div v-if="view.mode === 'confirm'" data-testid="confirm-prompt">
    <p class="text-[15px] leading-relaxed text-text-primary">
      Azt hiszem, erre gondoltál:
      <em class="text-text-secondary">
        <SorszamLink
          :text="view.confirmSummary ?? view.intent"
          @sorszam-click="emit('sorszamClick', $event)"
        />
      </em>
      — jó?
    </p>
    <div class="flex gap-2 mt-3">
      <Button size="md" data-testid="confirm-yes" @click="emit('run', view)">
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
        <Badge variant="info" :label="view.intent" />
        <Badge variant="default" :label="view.primitive" />
      </div>
      <span
        class="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md whitespace-nowrap"
        :class="confidenceClass(view.confidenceLabel)"
        data-testid="confidence-pill"
      >
        {{ CONFIDENCE_LABEL_HU[view.confidenceLabel] }}
      </span>
    </div>

    <div class="font-mono text-[11px] text-text-muted mb-1.5 tabular-nums">
      {{ view.periodLabel }}
    </div>
    <p class="text-[15px] leading-relaxed text-text-primary">
      <SorszamLink
        :text="view.summary"
        @sorszam-click="emit('sorszamClick', $event)"
      />
    </p>

    <!-- results -->
    <div
      v-if="view.results.length > 0"
      class="mt-3 divide-y divide-border-subtle/60"
    >
      <div
        v-for="row in view.results.slice(0, 8)"
        :key="row.sorszam ?? row.primary"
        class="py-1.5 first:pt-0"
        data-testid="result-row"
      >
        <div class="flex items-baseline gap-2 min-w-0">
          <span
            v-if="row.sorszam"
            class="font-mono text-[12px] text-accent shrink-0 cursor-pointer hover:text-accent-hover underline decoration-accent/40 hover:decoration-accent underline-offset-2"
            :data-testid="`result-row-sorszam-${row.sorszam}`"
            @click="
              row.sorszam &&
              emit('sorszamClick', {
                prefix: row.sorszam.startsWith('M') ? 'M' : 'B',
                sorszam: row.sorszam,
              })
            "
          >
            {{ row.sorszam }}
          </span>
          <span class="text-[13px] text-text-primary truncate min-w-0">
            <SorszamLink
              :text="row.primary"
              @sorszam-click="emit('sorszamClick', $event)"
            />
          </span>
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
      v-if="view.followUps.length > 0"
      class="flex flex-wrap gap-2 mt-3"
    >
      <button
        v-for="f in view.followUps"
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
      v-if="view.candidates.filter((c) => c.rank > 1).length > 0"
      class="mt-3"
      data-testid="candidates-expander"
    >
      <summary
        class="cursor-pointer text-[11px] font-mono uppercase tracking-wider text-text-muted hover:text-text-secondary"
      >
        Egyéb értelmezések ({{ view.candidates.filter((c) => c.rank > 1).length }})
      </summary>
      <div class="mt-2 space-y-1.5">
        <template
          v-for="(c, i) in view.candidates.filter((c) => c.rank > 1)"
          :key="c.rank"
        >
          <div
            v-if="i === 0 || c.family !== view.candidates.filter((x) => x.rank > 1)[i - 1]?.family"
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
            <span class="text-[12px] text-text-secondary truncate">
              <SorszamLink
                :text="c.summary"
                @sorszam-click="emit('sorszamClick', $event)"
              />
            </span>
          </div>
        </template>
      </div>
    </details>
  </div>
</template>
