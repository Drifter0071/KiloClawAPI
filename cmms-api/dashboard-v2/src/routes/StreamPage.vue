<script setup lang="ts">
// src/routes/StreamPage.vue
//
// HIG-flavoured Live Stream (Phase 7).
//
// Layout:
//   - Page header (52px): title + live counter + pause toggle on the
//     right. NO floating pill filters — the filter is a SegmentedControl
//     right next to the title in the same row.
//   - Compact AskBar (md size) directly under the header so the
//     operator can fire off a question without leaving the page.
//   - Feed renders as a structured, dense list with proper row layout:
//     fixed-width timestamp + status label + truncated body. 80ch max
//     width on the row to keep the lines scannable.
//   - The collapsible answer section below the feed shows a
//     AnswerBody for the most recent query.
//
// SSE lifecycle owned by useEventSource + stores/stream.ts.

import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import AskBar from '@/components/AskBar.vue'
import AnswerBody from '@/components/AnswerBody.vue'
import Button from '@/components/Button.vue'
import EmptyState from '@/components/EmptyState.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { useStreamEvents } from '@/composables/useStreamEvents'
import { useStreamStore } from '@/stores/stream'
import { setSeedQ } from '@/composables/useSeedQ'
import { connectionState } from '@/composables/useEventSource'
import { humanizeError } from '@/lib/errors'
import { renderAnswer, type AnswerView } from '@/lib/renderAnswer'
import type { AnswerRequest, AnswerResponse, StreamEvent } from '@/lib/api'

const { events, pause, togglePause } = useStreamEvents()

type FeedFilter = 'all' | 'questions' | 'approvals'

const FILTER_OPTIONS: { value: FeedFilter; label: string }[] = [
  { value: 'all', label: 'Mind' },
  { value: 'questions', label: 'Kérdések' },
  { value: 'approvals', label: 'Jóváhagyások' },
]

const filter = ref<FeedFilter>('all')

const visibleEvents = computed<StreamEvent[]>(() => {
  return events.value.filter((ev) => {
    if (ev.type === 'hello') return false
    if (filter.value === 'questions') return ev.type === 'question' || ev.type === 'answer'
    if (filter.value === 'approvals') return ev.type === 'approval'
    return true
  })
})

const eventCount = computed(() => visibleEvents.value.length)

function eventMeta(ev: StreamEvent): { label: string; border: string; body: string } {
  switch (ev.type) {
    case 'approval':
      return { label: 'JÓVÁHAGYÁS', border: 'border-l-amber-500', body: ev.summary }
    case 'answer':
      return { label: 'VÁLASZ', border: 'border-l-accent', body: ev.summary }
    case 'question':
      return { label: 'KÉRDÉS', border: 'border-l-accent', body: ev.q }
    default:
      return { label: ev.type.toUpperCase(), border: 'border-l-accent', body: '' }
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const connected = computed(() => connectionState.value === 'connected')

const lastEventAge = computed<string | null>(() => {
  const newest = events.value[0]
  if (!newest) return null
  const ms = Date.now() - Date.parse(newest.t)
  if (Number.isNaN(ms) || ms < 0) return null
  const mins = Math.max(1, Math.round(ms / 60_000))
  return `${mins}p`
})

// ---------------------------------------------------------------------------
// Inline ask → answer
// ---------------------------------------------------------------------------

const q = ref('')
const currentQ = ref('')
const run = ref(0)
const answerOpen = ref(false)
const inlineError = ref<string | null>(null)
const pendingFilters = ref<Partial<AnswerRequest>>({})

function detectLang(text: string): 'hu' | 'en' {
  return /[^\x00-\x7F]/.test(text) ? 'hu' : 'en'
}

const answerQuery = useQuery({
  queryKey: ['stream-answer', currentQ, run],
  queryFn: withAutoRetry(() =>
    useApi().answer({
      q: currentQ.value,
      language: detectLang(currentQ.value),
      ...pendingFilters.value,
    }),
  ),
  enabled: computed(() => run.value > 0),
})

const answerData = computed<AnswerResponse | null>(() => answerQuery.data.value ?? null)
const answerBusy = computed(() => run.value > 0 && answerQuery.isFetching.value)
const answerError = computed(() =>
  answerQuery.isError.value ? humanizeError(answerQuery.error.value) : null,
)

function submitQuestion(text: string) {
  const trimmed = text.trim()
  if (trimmed.length === 0 || answerBusy.value) return
  currentQ.value = trimmed
  pendingFilters.value = {}
  inlineError.value = null
  answerOpen.value = true
  run.value += 1
}

function showInAsk() {
  if (currentQ.value.length > 0) setSeedQ(currentQ.value)
}

function runConfirmed(view: AnswerView) {
  const filters: Partial<AnswerRequest> = {}
  const f = view.confirmFilters
  if (f) {
    for (const key of [
      'customer',
      'device',
      'kategoria',
      'kategoria_inferred',
      'sulyossag_inferred',
      'period',
      'status',
    ] as const) {
      const v = f[key]
      if (typeof v === 'string' && v.length > 0) filters[key] = v
    }
    if (typeof f.limit === 'number' && f.limit > 0) filters.limit = f.limit
  }
  currentQ.value = view.q
  pendingFilters.value = filters
  inlineError.value = null
  answerOpen.value = true
  run.value += 1
}

function retryAnswer() {
  inlineError.value = null
  run.value += 1
}

function collapseAnswer() {
  answerOpen.value = !answerOpen.value
}

// ---------------------------------------------------------------------------
// SSE subscription
// ---------------------------------------------------------------------------

let unsubscribeStream: (() => void) | null = null

onMounted(() => {
  const store = useStreamStore()
  unsubscribeStream = store.subscribe()
})

onScopeDispose(() => {
  unsubscribeStream?.()
  unsubscribeStream = null
})

watch(
  () => answerQuery.data.value,
  (data) => {
    if (data) answerOpen.value = true
  },
)
</script>

<template>
  <div class="h-full flex flex-col" data-testid="stream-page">
    <!-- Page header — structured, no floating pills -->
    <header
      class="h-13 px-4 md:px-6 flex items-center gap-4 border-b border-border-subtle bg-canvas-2/60 shrink-0"
    >
      <div class="min-w-0">
        <h1 class="text-[15px] font-semibold tracking-tight text-text-primary leading-none">
          Élő stream
        </h1>
        <p class="text-[12px] text-text-muted mt-1 truncate">
          Bejövő kérdések, válaszok, jóváhagyások
        </p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <SegmentedControl
          v-model="filter"
          :options="FILTER_OPTIONS"
          aria-label="Stream szűrése"
          data-testid="stream-filter"
        />
        <span
          class="hidden sm:inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-surface border border-border-subtle font-mono text-[11px] text-text-secondary tabular-nums"
          data-testid="live-counter"
        >
          <span
            class="inline-block w-1.5 h-1.5 rounded-full bg-success"
            :class="{ 'animate-pulse': connected }"
            aria-hidden="true"
          />
          {{ pause ? 'Szünetelve' : 'Élő' }} · {{ eventCount }} esemény
        </span>
        <Button
          variant="secondary"
          size="sm"
          data-testid="stream-pause"
          @click="togglePause"
        >
          {{ pause ? 'Folytatás' : 'Szünet' }}
        </Button>
      </div>
    </header>

    <!-- Compact AskBar — right under the header so the operator can fire
         a question from the stream without losing their place. -->
    <div class="px-4 md:px-6 py-3 border-b border-border-subtle shrink-0">
      <AskBar
        v-model="q"
        size="md"
        rounded="lg"
        input-id="stream-ask-input"
        placeholder="Kérdezd a CMMS-t…"
        :busy="answerBusy"
        @submit="submitQuestion"
      />
    </div>

    <!-- SSE disconnected banner -->
    <div
      v-if="!connected"
      class="px-4 md:px-6 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-300 shrink-0"
      data-testid="stream-banner"
    >
      A stream megszakadt
      <template v-if="lastEventAge"> — utolsó esemény {{ lastEventAge }} perce.</template>
      <template v-else>.</template>
      Újrapróbálkozás a háttérben.
    </div>

    <!-- Feed + answer section -->
    <div class="flex-1 min-h-0 overflow-y-auto">
      <EmptyState
        v-if="visibleEvents.length === 0"
        title="Várakozás a bejövő kérdésekre…"
        data-testid="stream-empty"
      >
        <template #actions>
          <span class="flex items-center gap-1.5" aria-hidden="true">
            <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span
              class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
              style="animation-delay: 150ms"
            />
            <span
              class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
              style="animation-delay: 300ms"
            />
          </span>
        </template>
      </EmptyState>

      <ul
        v-else
        class="divide-y divide-border-subtle"
        data-testid="stream-feed"
      >
        <li
          v-for="(ev, idx) in visibleEvents"
          :key="`${ev.t}-${ev.type}-${idx}`"
          class="px-4 md:px-6 py-3 hover:bg-surface-2/40 transition-colors duration-150 border-l-2"
          :class="eventMeta(ev).border"
          data-testid="stream-event"
        >
          <div class="flex items-center gap-3 md:gap-4 min-w-0 max-w-5xl">
            <span
              class="w-20 shrink-0 font-mono text-[11px] text-text-muted tabular-nums"
            >
              {{ fmtTime(ev.t) }}
            </span>
            <span
              class="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wider text-text-secondary"
              data-testid="event-type"
            >
              {{ eventMeta(ev).label }}
            </span>
            <span
              class="min-w-0 flex-1 text-[13px] text-text-primary truncate"
              :title="eventMeta(ev).body"
              data-testid="event-body"
            >
              {{ eventMeta(ev).body }}
            </span>
          </div>

          <div
            v-if="ev.type === 'approval'"
            class="mt-2 ml-24 flex items-center gap-2"
            data-testid="approval-actions"
          >
            <span class="text-[11px] text-text-muted">Prompt:</span>
            <span class="text-[12px] text-text-secondary truncate max-w-md">
              {{ ev.summary }}
            </span>
            <span class="flex items-center gap-2 ml-auto">
              <button
                type="button"
                disabled
                title="A jóváhagyási sor még nincs bekötve"
                class="h-7 px-2.5 text-[11px] rounded-md bg-success/15 text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="approval-approve"
              >
                Jóváhagy
              </button>
              <button
                type="button"
                disabled
                title="A jóváhagyási sor még nincs bekötve"
                class="h-7 px-2.5 text-[11px] rounded-md bg-danger/15 text-rose-300 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="approval-reject"
              >
                Elvet
              </button>
            </span>
          </div>
        </li>
      </ul>

      <!-- Collapsible answer section -->
      <div
        v-if="answerOpen && (answerData || answerBusy || answerError || inlineError)"
        class="border-t border-border-subtle bg-surface-2/40"
        data-testid="stream-answer"
      >
        <div class="px-4 md:px-6 py-3 flex items-center gap-3">
          <button
            type="button"
            class="text-xs text-text-muted hover:text-text-primary transition-colors"
            data-testid="answer-toggle"
            @click="collapseAnswer"
          >
            {{ answerOpen ? '▾' : '▸' }}
          </button>
          <span
            class="font-mono text-[10px] uppercase tracking-wider text-accent"
          >
            Válasz
          </span>
          <span class="min-w-0 flex-1 text-[13px] text-text-primary truncate">
            {{ currentQ }}
          </span>
          <button
            type="button"
            class="text-[12px] text-accent hover:text-accent-hover shrink-0"
            data-testid="show-in-ask"
            @click="showInAsk"
          >
            Megnyitás Ask-ban →
          </button>
        </div>

        <div
          v-if="answerBusy"
          class="px-4 md:px-6 pb-4 flex items-center gap-1.5"
          data-testid="answer-typing"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          <span
            class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
            style="animation-delay: 150ms"
          />
          <span
            class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
            style="animation-delay: 300ms"
          />
        </div>

        <div
          v-else-if="answerError || inlineError"
          class="px-4 md:px-6 pb-4"
          data-testid="answer-error"
        >
          <div class="bg-danger/[0.08] border border-danger/25 rounded-md px-4 py-3">
            <div class="text-[13px] text-rose-200">
              {{ answerError?.title ?? 'Valami elromlott' }}
            </div>
            <div
              v-if="answerError?.description"
              class="text-[11px] text-rose-200/70 mt-1"
            >
              {{ answerError.description }}
            </div>
            <div v-if="inlineError" class="text-[11px] text-rose-200/70 mt-1">
              {{ inlineError }}
            </div>
            <Button
              variant="secondary"
              size="sm"
              class="mt-2"
              data-testid="answer-retry"
              @click="retryAnswer"
            >
              Újra
            </Button>
          </div>
        </div>

        <div v-else-if="answerData" class="px-4 md:px-6 pb-4">
          <AnswerBody
            :data="answerData"
            @run="runConfirmed"
            @refine="q = ''"
            @followup="submitQuestion"
          />
        </div>
      </div>
    </div>
  </div>
</template>
