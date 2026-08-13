<script setup lang="ts">
// src/routes/AskPage.vue
//
// HIG-flavoured chat surface (Phase 7).
//
// Layout (matches Apple's Messages / Notes pattern):
//   - Empty state: centred hero with greeting + main search bar +
//     example chips.
//   - Conversation: messages scroll in a flex-1 column above a
//     STICKY-BOTTOM input bar (max-w-4xl, centred). The bar stays put
//     while the user scrolls.
//   - Each assistant message that has evidence shows a horizontal
//     scrollable row of "ticket cards" right under the message body.
//     Clicking a card opens the TicketInspector drawer (right-anchored
//     on desktop, bottom sheet on mobile) — without leaving the chat.
//   - Tapping a sorszam token (e.g. "B26071801" or "M26057") inside a
//     message bubble opens a TicketPanel on the right side. The
//     conversation reflows to the left column and the panel occupies
//     the right column at full viewport height. This is a HIG Notes-
//     style split view; on mobile the panel becomes a bottom sheet
//     above the conversation (not a side-by-side).
//   - Confirm-mode ("Azt hiszem…") and follow-up chips render inline
//     below the assistant message as before.
//
// State: chat history lives in the Pinia ask store (src/stores/ask.ts).
// The answer body is rendered via the typed view from lib/renderAnswer
// (no raw JSON). Pending filters from confirm-mode "Igen, futtasd" are
// carried across on the next submit.

import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import AskBar from '@/components/AskBar.vue'
import AnswerBody from '@/components/AnswerBody.vue'
import Button from '@/components/Button.vue'
import SorszamLink from '@/components/SorszamLink.vue'
import TicketInspector from '@/components/TicketInspector.vue'
import TicketPanel from '@/components/TicketPanel.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { consumeSeedQ } from '@/composables/useSeedQ'
import { useAskStore } from '@/stores/ask'
import { renderAnswer, type AnswerView, type EvidenceRow } from '@/lib/renderAnswer'
import { humanizeError } from '@/lib/errors'
import type { AnswerRequest, AnswerResponse, EvidenceTicket } from '@/lib/api'

const store = useAskStore()

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
// question with none is almost certainly English. Same heuristic as
// Stream page.
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
    chatScroll.value?.scrollTo({ top: chatScroll.value.scrollHeight, behavior: 'smooth' })
  })
}

function submitQuestion(text: string) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  currentQ.value = trimmed
  pendingFilters.value = {}
  store.busy = true
  store.push({ role: 'user', text: trimmed, ts: Date.now() })
  // Clear the input box so the operator can fire the next question
  // without manually backspacing the previous one. The message is
  // already in the chat history; the input is a transient composer.
  q.value = ''
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

/** Map an EvidenceRow (from renderAnswer) back to the wire EvidenceTicket
 *  shape that TicketInspector wants. The fields line up 1:1. */
function asTicket(row: EvidenceRow): EvidenceTicket {
  return {
    sorszam: row.sorszam,
    key: row.sorszam, // the wire uses `key`; we don't have it on the row, fall back to sorszam
    reported_at_iso: '', // not carried in the row — drawer shows '—'
    snippet: row.snippet,
    kategoria: row.kategoria,
    kategoria_inferred: null,
    sulyossag_inferred: null,
  }
}

/** All evidence tickets across all groups in the most recent answer,
 *  flattened for the card row. */
const evidenceCards = computed<EvidenceRow[]>(() => {
  for (let i = store.messages.length - 1; i >= 0; i -= 1) {
    const m = store.messages[i]
    if (m.role === 'assistant' && m.meta?.answer) {
      const v = renderAnswer(m.meta.answer)
      const all: EvidenceRow[] = []
      for (const g of v.evidence) {
        for (const t of g.tickets) all.push(t)
      }
      return all
    }
  }
  return []
})

/** Per-message evidence (so the card row sticks to the message that
 *  produced it, not just the newest answer). */
function evidenceFor(meta: AnswerResponse | undefined): EvidenceRow[] {
  if (!meta) return []
  const v = renderAnswer(meta)
  const all: EvidenceRow[] = []
  for (const g of v.evidence) {
    for (const t of g.tickets) all.push(t)
  }
  return all
}

const typing = computed(() => store.busy)

const EXAMPLE_CHIPS = [
  'M26057 vezérlés',
  'Top ügyfelek tavaly',
  'Kritikus ticketek most',
  'Melyik gép hibásodik meg legtöbbször?',
]

const GREETINGS: string[] = [
  'Kérdezz bármit a ticketekről, gépekről vagy ügyfelekről.',
  'Mi romlott el ma?',
  'Mintát keresel?',
  'Kell egy összefoglaló a múlt hónapról?',
  'Melyik gép a leghangosabb mostanában?',
  'Hogyan áll a várólista?',
  'Mit szeretnél tudni egy ügyfélről?',
  'Melyik vezérlő adja fel legtöbbször?',
  'Mikor volt utoljára kritikus hiba?',
  'Mi változott a CMMS-ben a héten?',
]

const greetingIdx = Math.floor(Math.random() * GREETINGS.length)
const greeting = ref(GREETINGS[greetingIdx]!)

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// Ticket inspector + ticket panel
//
// Two surfaces for showing ticket details:
//   1. TicketInspector (teleported drawer) — used by the evidence card
//      row under each assistant message. Right-anchored on desktop,
//      bottom-sheet on mobile. Doesn't reflow the conversation.
//   2. TicketPanel (in-place right column) — used when the operator
//      taps a sorszam token in a message bubble. The conversation
//      reflows to a left column and the panel occupies the right
//      column at full viewport height. On mobile the panel becomes
//      a bottom sheet that overlays the conversation.
//
// Both surfaces take the same EvidenceTicket shape. The sorszam-click
// flow synthesises a ticket from just the sorszam (the wire doesn't
// expose a /ticket/:sorszam endpoint today, so fields we don't have
// render as "—").
// ---------------------------------------------------------------------------

const inspectorOpen = ref(false)
const inspectorTicket = ref<EvidenceTicket | null>(null)

/** Sorszam tapped in a message bubble — drives the in-place panel. */
const panelOpen = ref(false)
const panelSorszam = ref<string | null>(null)
const panelTicket = computed<EvidenceTicket | null>(() => {
  if (!panelSorszam.value) return null
  return {
    sorszam: panelSorszam.value,
    key: panelSorszam.value,
    reported_at_iso: '',
    snippet: '',
    kategoria: null,
    kategoria_inferred: null,
    sulyossag_inferred: null,
  }
})

function openTicket(row: EvidenceRow) {
  inspectorTicket.value = asTicket(row)
  inspectorOpen.value = true
}

function closeInspector() {
  inspectorOpen.value = false
}

function onSorszamClick(sorszam: string) {
  panelSorszam.value = sorszam
  panelOpen.value = true
}

function closePanel() {
  panelOpen.value = false
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
  <div class="h-full flex flex-col" data-testid="ask-page">
    <!-- ============================================================ -->
    <!-- Chat scroll area                                             -->
    <!-- ============================================================ -->
    <div
      ref="chatScroll"
      class="flex-1 min-h-0 overflow-y-auto"
      data-testid="ask-scroll"
    >
      <!-- Empty state -->
      <div
        v-if="store.messages.length === 0"
        class="h-full flex items-center justify-center px-4 py-12"
        data-testid="ask-empty"
      >
        <div class="w-full max-w-2xl mx-auto text-center space-y-7">
          <h1
            class="text-[28px] md:text-[32px] font-semibold tracking-tight text-text-primary leading-tight"
            data-testid="ask-greeting"
          >
            {{ greeting }}
          </h1>
          <AskBar
            v-model="q"
            size="lg"
            rounded="lg"
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
              class="h-8 px-3 rounded-md bg-surface border border-border-subtle text-xs text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              data-testid="example-chip"
              @click="submitQuestion(chip)"
            >
              {{ chip }}
            </button>
          </div>
        </div>
      </div>

      <!-- Conversation (split with TicketPanel when a sorszam is tapped).
           When `panelOpen` is true the parent flex becomes a 2-column row
           (conversation on the left, panel on the right); the panel's own
           responsive classes turn it into a bottom sheet on mobile. -->
      <div
        v-else
        class="w-full h-full flex"
        :class="panelOpen ? 'flex-col md:flex-row' : 'block'"
        data-testid="ask-conversation-wrapper"
      >
        <div
          class="flex-1 min-w-0 overflow-y-auto"
          data-testid="ask-conversation-column"
        >
          <div
            class="mx-auto w-full max-w-4xl px-4 md:px-6 py-6 flex flex-col gap-5"
            :class="panelOpen ? 'md:ml-0 md:mr-0' : ''"
          >
            <template v-for="(m, idx) in store.messages" :key="idx">
              <!-- User message: right-aligned, primary-surface bubble -->
              <div
                v-if="m.role === 'user'"
                class="self-end max-w-[80%]"
                data-testid="user-message"
              >
                <div class="flex items-baseline gap-2.5 mb-1 justify-end">
                  <span class="font-mono text-[10px] text-text-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                  <span class="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                    Te
                  </span>
                </div>
                <div
                  class="bg-surface-2 border border-border-subtle rounded-2xl rounded-br-sm px-4 py-2.5 text-[15px] text-text-primary leading-relaxed"
                >
                  <SorszamLink :text="m.text" @sorszam-click="onSorszamClick" />
                </div>
              </div>

              <!-- Assistant: error bubble -->
              <div
                v-else-if="m.meta?.error"
                class="self-start max-w-[85%]"
                data-testid="assistant-error"
              >
                <div class="flex items-baseline gap-2.5 mb-1">
                  <span class="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                    CMMS
                  </span>
                  <span class="font-mono text-[10px] text-text-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                </div>
                <div
                  class="bg-danger/[0.08] border border-danger/25 rounded-2xl rounded-tl-sm px-4 py-3 text-[14px] text-rose-200"
                >
                  <div class="font-medium">{{ m.text }}</div>
                  <div v-if="m.meta.error" class="text-xs text-rose-200/70 mt-1">
                    {{ m.meta.error }}
                  </div>
                </div>
              </div>

              <!-- Assistant: answer with optional evidence card row -->
              <div
                v-else-if="m.meta?.answer"
                class="self-start max-w-[90%]"
                data-testid="assistant-answer"
              >
                <div class="flex items-baseline gap-2.5 mb-1">
                  <span class="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                    CMMS
                  </span>
                  <span class="font-mono text-[10px] text-text-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                </div>
                <div
                  class="bg-surface border border-border-subtle rounded-2xl rounded-tl-sm px-4 py-3"
                >
                  <AnswerBody
                    :data="m.meta.answer"
                    @run="runConfirmed"
                    @refine="refineQuestion"
                    @followup="submitQuestion"
                  />
                </div>

                <!-- Evidence card row (HIG compact-tile pattern). -->
                <div
                  v-if="evidenceFor(m.meta.answer).length > 0"
                  class="mt-3 -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 snap-x"
                  data-testid="evidence-card-row"
                >
                  <button
                    v-for="t in evidenceFor(m.meta.answer)"
                    :key="t.sorszam"
                    type="button"
                    class="snap-start shrink-0 w-56 text-left bg-surface hover:bg-surface-2 border border-border-subtle hover:border-border-strong rounded-lg px-3 py-2.5 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    :aria-label="`Ticket ${t.sorszam} részletei`"
                    :data-testid="`evidence-ticket-${t.sorszam}`"
                    @click="openTicket(t)"
                  >
                    <div class="font-mono text-[11px] text-accent">{{ t.sorszam }}</div>
                    <p class="mt-1 text-[12px] text-text-secondary line-clamp-2 leading-snug">
                      {{ t.snippet }}
                    </p>
                    <div
                      v-if="t.kategoria"
                      class="mt-1.5 text-[10px] font-mono uppercase tracking-wider text-text-muted"
                    >
                      {{ t.kategoria }}
                    </div>
                  </button>
                </div>
              </div>
            </template>

            <!-- Inline transport / non-answer error -->
            <div
              v-if="errorText"
              class="self-start bg-danger/[0.08] border border-danger/25 rounded-md px-4 py-3 text-[13px] text-rose-200 flex items-center justify-between gap-3"
              data-testid="inline-error"
            >
              <span>{{ errorText }}</span>
              <Button
                variant="secondary"
                size="sm"
                data-testid="inline-error-retry"
                @click="retryLast"
              >
                Újra
              </Button>
            </div>

            <!-- Typing indicator -->
            <div
              v-if="typing"
              class="self-start"
              data-testid="typing-indicator"
            >
              <div class="flex items-baseline gap-2.5 mb-1">
                <span class="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                  CMMS
                </span>
              </div>
              <div
                class="bg-surface border border-border-subtle rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5"
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
            </div>
          </div>
        </div>

        <!-- In-place right column. Renders only when a sorszam was tapped.
             The TicketPanel handles its own mobile bottom-sheet layout. -->
        <TicketPanel
          v-if="panelOpen"
          :open="panelOpen"
          :ticket="panelTicket"
          class="md:w-[420px] md:h-auto max-h-[60vh] md:max-h-none"
          @update:open="closePanel"
        />
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- Sticky-bottom composer                                        -->
    <!-- ============================================================ -->
    <div
      v-if="store.messages.length > 0"
      class="shrink-0 border-t border-border-subtle bg-canvas-2/90 backdrop-blur-xl"
      data-testid="ask-composer"
    >
      <div
        class="mx-auto w-full px-4 md:px-6 py-3"
        :class="panelOpen ? 'max-w-4xl md:max-w-[calc(100vw-420px)]' : 'max-w-4xl'"
      >
        <AskBar
          v-model="q"
          size="md"
          rounded="lg"
          input-id="ask-input"
          placeholder="Kérdezd a CMMS-t…"
          :disabled="typing"
          :busy="typing"
          @submit="submitQuestion"
        />
      </div>
    </div>

    <!-- Ticket inspector (right-drawer on desktop, bottom sheet on mobile) -->
    <TicketInspector
      :open="inspectorOpen"
      :ticket="inspectorTicket"
      @update:open="closeInspector"
    />
  </div>
</template>
