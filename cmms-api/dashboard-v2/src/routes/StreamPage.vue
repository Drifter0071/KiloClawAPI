<script setup lang="ts">
// src/routes/StreamPage.vue
//
// Live Stream — spec §5.2. Renders the rolling SSE event log from the
// Pinia stream store (stores/stream.ts), with filter chips, a pause
// toggle, a compact ask banner, and a collapsible answer section below
// the feed.
//
// The SSE connection lifecycle is owned by useEventSource +
// stores/stream.ts — this page just subscribes on mount and unsubscribes
// on scope dispose.

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

// ---------------------------------------------------------------------------
// Stream feed
// ---------------------------------------------------------------------------

const { events, pause, togglePause } = useStreamEvents()

/** Filter chips: All | Questions | Approvals. hello is a handshake, not a feed row. */
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
      return { label: 'VÁLASZ', border: 'border-l-sky-500', body: ev.summary }
    case 'question':
      return { label: 'KÉRDÉS', border: 'border-l-sky-500', body: ev.q }
    default:
      return { label: ev.type.toUpperCase(), border: 'border-l-sky-500', body: '' }
  }
}

/** HH:MM:SS local wall-clock for the row timestamp. */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const connected = computed(() => connectionState.value === 'connected')

/** "14m" from the newest buffered event (or null if the buffer is empty). */
const lastEventAge = computed<string | null>(() => {
  const newest = events.value[0]
  if (!newest) return null
  const ms = Date.now() - Date.parse(newest.t)
  if (Number.isNaN(ms) || ms < 0) return null
  const mins = Math.max(1, Math.round(ms / 60_000))
  return `${mins}m`
})

// ---------------------------------------------------------------------------
// Compact ask banner → collapsible answer section
// ---------------------------------------------------------------------------

const q = ref('')
const currentQ = ref('')
const run = ref(0)
const answerOpen = ref(false)
const inlineError = ref<string | null>(null)
/** Extra filters carried over from confirm-mode "Yes, run it". */
const pendingFilters = ref<Partial<AnswerRequest>>({})

// Hungarian text almost always contains non-ASCII letters; anything
// without them is treated as English. Same heuristic as AskPage.
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

/** "Show in Ask →" — hand the question to the Ask page, which owns history. */
function showInAsk() {
  if (currentQ.value.length > 0) setSeedQ(currentQ.value)
}

/** AnswerBody confirm-mode "Yes, run it" — re-submit with winning filters. */
function runConfirmed(view: AnswerView) {
  const filters: Partial<AnswerRequest> = {}
  const f = view.confirmFilters
  if (f) {
    for (const key of ['customer', 'device', 'kategoria', 'kategoria_inferred', 'sulyossag_inferred', 'period', 'status'] as const) {
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
// SSE subscription — one per browser tab (ref-counted in the store).
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

// Auto-open the answer section when a fresh answer lands.
watch(
  () => answerQuery.data.value,
  (data) => {
    if (data) answerOpen.value = true
  },
)
</script>

<template>
  <div class="h-full flex flex-col" data-testid="stream-page">
    <!-- Compact ask banner + filters + counter -->
    <div
      class="px-6 py-3 border-b border-border-subtle flex items-center gap-3 shrink-0"
    >
      <AskBar
        v-model="q"
        size="md"
        rounded="full"
        input-id="stream-ask-input"
        placeholder="Kérdezd a CMMS-t…"
        :busy="answerBusy"
        @submit="submitQuestion"
      />
      <SegmentedControl
        v-model="filter"
        :options="FILTER_OPTIONS"
        aria-label="Stream szrése"
        data-testid="stream-filter"
      />
      <div class="flex items-center gap-3 ml-auto shrink-0">
        <span
          class="text-xs font-mono text-text-muted tabular-nums whitespace-nowrap"
          data-testid="live-counter"
        >
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
    </div>

    <!-- SSE disconnected banner -->
    <div
      v-if="!connected"
      class="px-6 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-300"
      data-testid="stream-banner"
    >
      A stream megszakadt
      <template v-if="lastEventAge"> — utolsó esemény {{ lastEventAge }} perce.</template>
      <template v-else>.</template>
      Újrapróbálkozás a háttérben.
    </div>

    <!-- Feed + answer section -->
    <div class="flex-1 overflow-y-auto">
      <!-- Empty feed -->
      <EmptyState
        v-if="visibleEvents.length === 0"
        title="Várakozás a bejövő kérdésekre…"
        data-testid="stream-empty"
      >
        <template #actions>
          <span class="flex items-center gap-1.5" aria-hidden="true">
            <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" style="animation-delay: 150ms" />
            <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" style="animation-delay: 300ms" />
          </span>
        </template>
      </EmptyState>

      <!-- Event rows -->
      <div
        v-for="(ev, idx) in visibleEvents"
        :key="`${ev.t}-${ev.type}-${idx}`"
        class="border-b border-border-subtle px-6 py-3 hover:bg-surface-2/50 transition-colors duration-150"
        data-testid="stream-event"
      >
        <div class="flex items-center gap-4">
          <span class="w-20 shrink-0 font-mono text-xs text-text-muted tabular-nums">
            {{ fmtTime(ev.t) }}
          </span>
          <span
            class="w-24 shrink-0 font-mono text-xs uppercase tracking-wider text-text-secondary"
            data-testid="event-type"
          >
            {{ eventMeta(ev).label }}
          </span>
          <span
            class="min-w-0 flex-1 text-sm text-text-primary truncate"
            :title="eventMeta(ev).body"
            data-testid="event-body"
          >
            {{ eventMeta(ev).body }}
          </span>
        </div>

        <!-- Approval action row — disabled until a producer wires the queue -->
        <div
          v-if="ev.type === 'approval'"
          class="mt-2 ml-24 flex items-center gap-2"
          data-testid="approval-actions"
        >
          <span class="text-xs text-text-muted">Prompt:</span>
          <span class="text-xs text-text-secondary truncate max-w-md">
            {{ ev.summary }}
          </span>
          <span class="flex items-center gap-2 ml-auto">
            <button
              type="button"
              disabled
              title="A jóváhagyási sor még nincs bekötve"
              class="h-7 px-2.5 text-xs rounded-md bg-emerald-500/15 text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="approval-approve"
            >
              Jóváhagy
            </button>
            <button
              type="button"
              disabled
              title="A jóváhagyási sor még nincs bekötve"
              class="h-7 px-2.5 text-xs rounded-md bg-rose-500/15 text-rose-300 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="approval-reject"
            >
              Elvet
            </button>
          </span>
        </div>
      </div>

      <!-- Collapsible answer section (below the feed) -->
      <div
        v-if="answerOpen && (answerData || answerBusy || answerError || inlineError)"
        class="border-t border-border-subtle bg-surface/60"
        data-testid="stream-answer"
      >
        <div class="px-6 py-3 flex items-center gap-3">
          <button
            type="button"
            class="text-xs text-text-muted hover:text-text-primary transition-colors"
            data-testid="answer-toggle"
            @click="collapseAnswer"
          >
            {{ answerOpen ? '▾' : '▸' }}
          </button>
          <span class="font-mono text-xs uppercase tracking-wider text-accent">Válasz</span>
          <span class="min-w-0 flex-1 text-sm text-text-primary truncate">
            {{ currentQ }}
          </span>
          <button
            type="button"
            class="text-xs text-accent hover:text-accent-hover shrink-0"
            data-testid="show-in-ask"
            @click="showInAsk"
          >
            Megnyitás Ask-ban →
          </button>
        </div>

        <div v-if="answerBusy" class="px-6 pb-4 flex items-center gap-1.5" data-testid="answer-typing">
          <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" style="animation-delay: 150ms" />
          <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" style="animation-delay: 300ms" />
        </div>

        <div
          v-else-if="answerError || inlineError"
          class="px-6 pb-4"
          data-testid="answer-error"
        >
          <div class="bg-rose-500/10 border border-rose-500/30 rounded-md px-4 py-3">
            <div class="text-sm text-rose-200">{{ answerError?.title ?? 'Valami elromlott' }}</div>
            <div v-if="answerError?.description" class="text-xs text-rose-200/70 mt-1">
              {{ answerError.description }}
            </div>
            <div v-if="inlineError" class="text-xs text-rose-200/70 mt-1">{{ inlineError }}</div>
            <Button variant="secondary" size="sm" class="mt-2" data-testid="answer-retry" @click="retryAnswer">
              Újra
            </Button>
          </div>
        </div>

        <div v-else-if="answerData" class="px-6 pb-4">
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
