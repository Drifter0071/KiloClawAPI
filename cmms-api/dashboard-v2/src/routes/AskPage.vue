<script setup lang="ts">
// src/routes/AskPage.vue
//
// Ask the CMMS — spec §5.1. Chat history lives in the Pinia ask store
// (src/stores/ask.ts). The answer body is rendered from the typed view
// produced by lib/renderAnswer.ts (via components/AnswerBody.vue) —
// never from raw JSON.
//
// Flow: submit → push user message → useQuery(['answer', q, run])
// (manually triggered via the run counter) → push assistant message with
// meta.answer, or an error bubble when it fails.

import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import AskBar from '@/components/AskBar.vue'
import AnswerBody from '@/components/AnswerBody.vue'
import Button from '@/components/Button.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { consumeSeedQ } from '@/composables/useSeedQ'
import { useAskStore } from '@/stores/ask'
import { renderAnswer, type AnswerView } from '@/lib/renderAnswer'
import { humanizeError } from '@/lib/errors'
import { useMediaQuery } from '@/composables/useMediaQuery'
import type { AnswerRequest, AnswerResponse } from '@/lib/api'

const store = useAskStore()
const wide = useMediaQuery('(min-width: 1024px)')

// ---------------------------------------------------------------------------
// Question state — vue-query manual trigger
// ---------------------------------------------------------------------------

const q = ref('')
const currentQ = ref('')
const run = ref(0)
/** Extra filters carried over from confirm-mode "Yes, run it". */
const pendingFilters = ref<Partial<AnswerRequest>>({})
const errorText = ref<string | null>(null)

const chatScroll = ref<HTMLElement | null>(null)

// Hungarian text always contains non-ASCII letters (á, é, ő, ü, …); a
// question with none is almost certainly English. Simple heuristic,
// documented here so it's easy to replace with a real detector.
function detectLang(text: string): 'hu' | 'en' {
  return /[^\x00-\x7F]/.test(text) ? 'hu' : 'en'
}

function buildRequest(qText: string): Promise<AnswerResponse> {
  return useApi().answer({ q: qText, language: detectLang(qText), ...pendingFilters.value })
}

const query = useQuery({
  queryKey: ['answer', currentQ, run],
  queryFn: withAutoRetry(() => buildRequest(currentQ.value)),
  enabled: computed(() => run.value > 0),
})

// ---------------------------------------------------------------------------
// Submit flows
// ---------------------------------------------------------------------------

function scrollToBottom() {
  nextTick(() => {
    chatScroll.value?.scrollTo({ top: chatScroll.value.scrollHeight })
  })
}

function submitQuestion(text: string) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  currentQ.value = trimmed
  pendingFilters.value = {}
  store.busy = true
  store.push({ role: 'user', text: trimmed, ts: Date.now() })
  run.value += 1
  errorText.value = null
  scrollToBottom()
}

/** Confirm mode: "Yes, run it" — re-submit with the winning candidate's filters. */
function runConfirmed(view: AnswerView) {
  const filters: Partial<AnswerRequest> = {}
  const f = view.confirmFilters
  if (f) {
    for (const key of ['customer', 'device', 'kategoria', 'kategoria_inferred', 'sulyossag_inferred', 'period', 'status'] as const) {
      const v = f[key]
      if (typeof v === 'string' && v.length > 0) {
        filters[key] = v
      }
    }
    if (typeof f.limit === 'number' && f.limit > 0) filters.limit = f.limit
  }
  currentQ.value = view.q
  pendingFilters.value = filters
  store.busy = true
  store.push({ role: 'user', text: view.q, ts: Date.now() })
  run.value += 1
  errorText.value = null
  scrollToBottom()
}

/** Confirm mode: "No, refine" — clear the input and focus it. */
function refineQuestion() {
  q.value = ''
  errorText.value = null
  nextTick(() => document.getElementById('ask-input')?.focus())
}

function retryLast() {
  if (currentQ.value.length === 0) return
  store.busy = true
  errorText.value = null
  run.value += 1
}

// ---------------------------------------------------------------------------
// Query lifecycle → chat history
// ---------------------------------------------------------------------------

let handledRun = 0

watch(query.data, (data) => {
  if (!data || handledRun >= run.value) return
  handledRun = run.value
  const view = renderAnswer(data)
  store.busy = false
  store.push({ role: 'assistant', text: view.summary, ts: Date.now(), meta: { answer: data } })
  scrollToBottom()
})

watch(query.isError, (isErr) => {
  if (!isErr || handledRun >= run.value) return
  handledRun = run.value
  store.busy = false
  const h = humanizeError(query.error.value)
  errorText.value = h.description
  store.push({ role: 'assistant', text: h.title, ts: Date.now(), meta: { error: h.description } })
  scrollToBottom()
})

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/** The most recent assistant answer (for the evidence rail). */
const lastAnswer = computed<AnswerView | null>(() => {
  for (let i = store.messages.length - 1; i >= 0; i -= 1) {
    const m = store.messages[i]
    if (m.role === 'assistant' && m.meta?.answer) {
      return renderAnswer(m.meta.answer)
    }
  }
  return null
})

const evidenceRail = computed(() => lastAnswer.value?.evidence ?? [])

const typing = computed(() => store.busy)

const EXAMPLE_CHIPS = [
  'M26057 vezérlés',
  'Top ügyfelek tavaly',
  'Kritikus ticketek most',
  'Melyik gép hibásodik meg legtöbbször?',
]

/**
 * Empty-state greetings — picked once per mount. Hungarian-only, since
 * the dashboard is HU per design (operator + data both Hungarian).
 * Question-flavored so each one doubles as a hint about what Ask the
 * CMMS can answer.
 */
const GREETINGS: string[] = [
  'Kérdezz bármit a ticketekrl, gépekrl vagy ügyfelekrl.',
  'Mi romlott el ma?',
  'Mintát keresel?',
  'Kell egy összefoglaló a múlt hónapróI?',
  'Melyik gép a leghangosabb mostanában?',
  'Hogyan áll a várólista?',
  'Mit szeretnél tudni egy ügyfélrl?',
  'Melyik vezérll adja fel legtöbbször?',
  'Mikor volt utoljára kritikus hiba?',
  'Mi változott a CMMS-ben a héten?',
]

/** Pick a fresh greeting on every mount (one per page load). */
const greetingIdx = Math.floor(Math.random() * GREETINGS.length)
const greeting = ref(GREETINGS[greetingIdx]!)

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// seedQ handoff (from Stream / Diff / Map "Show in Ask →" links)
// ---------------------------------------------------------------------------

onMounted(() => {
  const seed = consumeSeedQ()
  if (seed && seed.length > 0) {
    q.value = seed
    submitQuestion(seed)
  }
})
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Chat area -->
    <div ref="chatScroll" class="flex-1 overflow-y-auto px-8 py-6">
      <!-- Empty state -->
      <div
        v-if="store.messages.length === 0"
        class="h-full flex items-center justify-center"
        data-testid="ask-empty"
      >
        <div class="max-w-2xl mx-auto text-center space-y-6">
          <div>
            <h1 class="text-2xl font-semibold text-text-primary" data-testid="ask-greeting">
              {{ greeting }}
            </h1>
          </div>
          <AskBar
            v-model="q"
            size="lg"
            rounded="full"
            input-id="ask-input"
            placeholder="Kérdezd a CMMS-t…"
            :disabled="typing"
            @submit="submitQuestion"
          />
          <div class="flex flex-wrap justify-center gap-2">
            <button
              v-for="chip in EXAMPLE_CHIPS"
              :key="chip"
              type="button"
              class="h-8 px-3 rounded-full bg-surface border border-border-subtle text-xs text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              data-testid="example-chip"
              @click="submitQuestion(chip)"
            >
              {{ chip }}
            </button>
          </div>
        </div>
      </div>

      <!-- Messages -->
      <div v-else class="max-w-5xl mx-auto flex gap-6">
        <div class="flex-1 min-w-0 flex flex-col gap-4">
          <template v-for="(m, idx) in store.messages" :key="idx">
            <!-- User bubble -->
            <div
              v-if="m.role === 'user'"
              class="max-w-[85%] self-end bg-surface border border-border-subtle rounded-2xl rounded-br-md px-4 py-2.5 text-md text-text-primary"
              data-testid="user-message"
            >
              <span class="flex items-center gap-3">
                <span>{{ m.text }}</span>
                <span class="font-mono text-[11px] text-text-muted whitespace-nowrap">{{ fmtTime(m.ts) }}</span>
              </span>
            </div>

            <!-- Assistant: error bubble -->
            <div
              v-else-if="m.meta?.error"
              class="max-w-[85%] self-start bg-rose-500/10 border border-rose-500/30 rounded-2xl rounded-tl-md px-4 py-3 text-sm text-rose-200"
              data-testid="assistant-error"
            >
              <div class="font-medium">{{ m.text }}</div>
            </div>

            <!-- Assistant: answer -->
            <div
              v-else-if="m.meta?.answer"
              class="max-w-[85%] self-start bg-sky-500/[0.06] border border-sky-500/20 rounded-2xl rounded-tl-md px-4 py-3"
              data-testid="assistant-answer"
            >
              <AnswerBody
                :data="m.meta.answer"
                @run="runConfirmed"
                @refine="refineQuestion"
                @followup="submitQuestion"
              />
            </div>
          </template>

          <!-- Inline error (non-transport failures, e.g. 404) -->
        <div
          v-if="errorText"
          class="bg-rose-500/10 border border-rose-500/30 rounded-md px-4 py-3 text-sm text-rose-200 flex items-center justify-between gap-3"
          data-testid="inline-error"
        >
          <span>{{ errorText }}</span>
          <Button variant="secondary" size="sm" data-testid="inline-error-retry" @click="retryLast">
            Újra
          </Button>
        </div>

        <!-- Typing indicator -->
          <div
            v-if="typing"
            class="max-w-[85%] self-start bg-sky-500/[0.06] border border-sky-500/20 rounded-2xl rounded-tl-md px-4 py-3"
            data-testid="typing-indicator"
          >
            <span class="flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" style="animation-delay: 150ms" />
              <span class="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" style="animation-delay: 300ms" />
            </span>
          </div>
        </div>

        <!-- Evidence rail (>= 1024px) -->
        <aside
          v-if="wide && evidenceRail.length > 0"
          class="w-80 shrink-0 hidden lg:block"
          data-testid="evidence-rail"
        >
          <div class="sticky top-0 space-y-4 py-2">
            <div v-for="group in evidenceRail" :key="group.label">
              <div class="text-xs font-medium text-text-secondary uppercase tracking-wider">{{ group.label }}</div>
              <div v-for="t in group.tickets" :key="t.sorszam" class="mt-1.5">
                <span class="font-mono text-xs text-accent/90">{{ t.sorszam }}</span>
                <div class="text-xs text-text-muted line-clamp-2">{{ t.snippet }}</div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>

    <!-- Main search bar (in-flow, only when chat is active — the hero
         covers the empty state). Not sticky: one bar, one look. -->
    <div
      v-if="store.messages.length > 0"
      class="px-6 py-4 border-t border-border-subtle shrink-0"
      data-testid="ask-bottom-bar"
    >
      <div class="max-w-5xl mx-auto">
        <AskBar
          v-model="q"
          size="lg"
          rounded="full"
          input-id="ask-input"
          placeholder="Kérdezd a CMMS-t…"
          :disabled="typing"
          :busy="typing"
          @submit="submitQuestion"
        />
      </div>
    </div>
  </div>
</template>
