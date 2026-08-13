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
//     on desktop, bottom sheet on mobile) â€” without leaving the chat.
//   - Tapping a sorszam token (e.g. "B26071801" or "M26057") inside a
//     message bubble opens a TicketPanel on the right side. The
//     conversation reflows to the left column and the panel occupies
//     the right column at full viewport height. This is a HIG Notes-
//     style split view; on mobile the panel becomes a bottom sheet
//     above the conversation (not a side-by-side).
//   - Confirm-mode ("Azt hiszemâ€¦") and follow-up chips render inline
//     below the assistant message as before.
//
// State: chat history lives in the Pinia ask store (src/stores/ask.ts).
// The answer body is rendered via the typed view from lib/renderAnswer
// (no raw JSON). Pending filters from confirm-mode "Igen, futtasd" are
// carried across on the next submit.

import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import AgentBody from '@/components/AgentBody.vue'
import AskBar from '@/components/AskBar.vue'
import AnswerBody from '@/components/AnswerBody.vue'
import AskThreadBar from '@/components/AskThreadBar.vue'
import Button from '@/components/Button.vue'
import SorszamLink from '@/components/SorszamLink.vue'
import TicketInspector from '@/components/TicketInspector.vue'
import TicketPanel from '@/components/TicketPanel.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { consumeSeedQ, setSeedQ } from '@/composables/useSeedQ'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useAskStore } from '@/stores/ask'
import { renderAnswer, type AnswerView, type EvidenceRow } from '@/lib/renderAnswer'
import { humanizeError } from '@/lib/errors'
import type { AnswerAgentResponse, AnswerResponse, EvidenceTicket } from '@/lib/api'

const store = useAskStore()

// ---------------------------------------------------------------------------
// Layout / responsive
// ---------------------------------------------------------------------------

/** True when the viewport is below Tailwind's `md` breakpoint
 *  (i.e. < 768px). Used to switch the docked composer between the
 *  large hero-style input and the compact sticky one. SSR-safe:
 *  defaults to false (desktop) and updates on mount. */
const isMobile = useMediaQuery('(max-width: 767px)')

/** Composer size for the docked AskBar.
 *    - mobile, no messages yet: lg  (big hero input, "the big main
 *      input till the first message is sent")
 *    - mobile, after first message: md (compact sticky)
 *    - desktop: md (always compact — the hero lives in the empty
 *      state above)
 *  The user explicitly asked for the big input to be kept on
 *  mobile until the first message is sent. */
const composerSize = computed<'lg' | 'md'>(() => {
  if (isMobile.value && store.messages.length === 0) return 'lg'
  return 'md'
})

// ---------------------------------------------------------------------------
// Question state â€” vue-query manual trigger
// ---------------------------------------------------------------------------

const q = ref('')
const currentQ = ref('')
const run = ref(0)
const errorText = ref<string | null>(null)

const chatScroll = ref<HTMLElement | null>(null)

// Hungarian text always contains non-ASCII letters (Ăˇ, Ă©, Ĺ‘, ĂĽ, â€¦); a
// question with none is almost certainly English. Same heuristic as
// Stream page.
function detectLang(text: string): 'hu' | 'en' {
  return /[^\x00-\x7F]/.test(text) ? 'hu' : 'en'
}

// ALWAYS the agentic path (user decision 2026-08-13: gpt-4o picks and
// calls the tools, always on â€” "goodbye to the current system"). The
// deterministic /v1/answer stays for the MCP answer_question + legacy
// history rendering.
function buildRequest(qText: string): Promise<AnswerAgentResponse> {
  return useApi().answerAgent({
    q: qText,
    language: detectLang(qText),
  })
}

const query = useQuery({
  queryKey: ['answer-agent', currentQ, run],
  queryFn: withAutoRetry(() => buildRequest(currentQ.value)),
  enabled: computed(() => run.value > 0),
})

// ---------------------------------------------------------------------------
// Submit flows
// ---------------------------------------------------------------------------

/**
 * Scroll the chat so the most recently added message is at the top of
 * the viewport. The previous version scrolled to the bottom of the
 * chat (`scrollHeight`) which forced the user to look down past all
 * the prior conversation to see what they just sent. The current
 * approach keeps the new exchange (question + answer) at the top of
 * the visible area â€” the user always sees the latest message, and
 * the response that comes in below it is immediately visible too.
 *
 * Implementation: locate the last child of the conversation column
 * (the one that owns message data-testid) and `scrollIntoView` with
 * `block: 'start'` so its top edge aligns with the top of the
 * scroll container. A small CSS padding above the column keeps the
 * message from butting against the very top of the chat box.
 *
 * For the user-submit case there's no "latest assistant message"
 * yet â€” the latest message is the new user bubble â€” so the same
 * `last-message-at-top` behaviour works for both: the user's
 * question appears at the top, the incoming response slides in
 * below it, and the next `scrollToLatestMessage` call (triggered
 * when the response lands) puts the new assistant answer at top.
 */
function scrollToLatestMessage() {
  nextTick(() => {
    const outer = chatScroll.value
    if (!outer) return
    // The conversation-column element is the inner scroll container
    // when a TicketPanel is open. We need to scroll THAT one, not
    // the outer chatScroll, because the column is the one with
    // `overflow-y-auto` in the panel-open branch.
    const column = outer.querySelector('[data-testid="ask-conversation-column"]') as HTMLElement | null
    const scroller: HTMLElement = column ?? outer
    const messages = scroller.querySelectorAll(
      '[data-testid="user-message"], [data-testid="assistant-error"], [data-testid="assistant-agent"], [data-testid="assistant-answer"]',
    )
    const last = messages[messages.length - 1] as HTMLElement | undefined
    if (!last) {
      // No messages yet (shouldn't happen — we only call this after
      // push) — fall back to the top.
      scroller.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    // Compute the message's offset relative to the scroll container
    // and align it with the container's top edge. Using offsetTop
    // (rather than scrollIntoView) lets us subtract the container's
    // own scrollTop so the math is correct in nested-scroll cases
    // (TicketPanel open, mobile bottom-sheet, etc.).
    const containerRect = scroller.getBoundingClientRect()
    const msgRect = last.getBoundingClientRect()
    const delta = msgRect.top - containerRect.top
    const targetTop = scroller.scrollTop + delta - 8 // 8px breathing room
    scroller.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
  })
}

function submitQuestion(text: string) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  currentQ.value = trimmed
  store.busy = true
  store.push({ role: 'user', text: trimmed, ts: Date.now() })
  // Clear the input box so the operator can fire the next question
  // without manually backspacing the previous one. The message is
  // already in the chat history; the input is a transient composer.
  q.value = ''
  run.value += 1
  errorText.value = null
  scrollToLatestMessage()
}

/** Legacy confirm mode: "Yes, run it" â€” re-ask through the agent (it
 *  has the full tool surface and can resolve the ambiguity itself). */
function runConfirmed(view: AnswerView) {
  currentQ.value = view.q
  store.busy = true
  store.push({ role: 'user', text: view.q, ts: Date.now() })
  run.value += 1
  errorText.value = null
  scrollToLatestMessage()
}

/** Confirm mode: "No, refine" â€” clear the input and focus it. */
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
// Query lifecycle â†’ chat history
// ---------------------------------------------------------------------------

let handledRun = 0

watch(query.data, (data) => {
  if (!data || handledRun >= run.value) return
  handledRun = run.value
  store.busy = false
  // Per-client threads: a fresh answer may resolve to a different
  // customer â€” switch to that customer's thread (loads its history)
  // BEFORE appending so the message lands in the right conversation.
  // The agent returns `resolved_customer` (from the deterministic
  // router's answer_question call) for exactly this.
  store.resolveThreadFromAnswer(data)
  store.push({ role: 'assistant', text: data.final_text, ts: Date.now(), meta: { agent: data } })
  scrollToLatestMessage()
})

watch(query.isError, (isErr) => {
  if (!isErr || handledRun >= run.value) return
  handledRun = run.value
  store.busy = false
  const h = humanizeError(query.error.value)
  errorText.value = h.description
  store.push({ role: 'assistant', text: h.title, ts: Date.now(), meta: { error: h.description } })
  scrollToLatestMessage()
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
    reported_at_iso: '', // not carried in the row â€” drawer shows 'â€”'
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
  'M26057 vezĂ©rlĂ©s',
  'Top ĂĽgyfelek tavaly',
  'Kritikus ticketek most',
  'Melyik gĂ©p hibĂˇsodik meg legtĂ¶bbszĂ¶r?',
]

const GREETINGS: string[] = [
  'KĂ©rdezz bĂˇrmit a ticketekrĹ‘l, gĂ©pekrĹ‘l vagy ĂĽgyfelekrĹ‘l.',
  'Mi romlott el ma?',
  'MintĂˇt keresel?',
  'Kell egy Ă¶sszefoglalĂł a mĂşlt hĂłnaprĂłl?',
  'Melyik gĂ©p a leghangosabb mostanĂˇban?',
  'Hogyan Ăˇll a vĂˇrĂłlista?',
  'Mit szeretnĂ©l tudni egy ĂĽgyfĂ©lrĹ‘l?',
  'Melyik vezĂ©rlĹ‘ adja fel legtĂ¶bbszĂ¶r?',
  'Mikor volt utoljĂˇra kritikus hiba?',
  'Mi vĂˇltozott a CMMS-ben a hĂ©ten?',
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
//   1. TicketInspector (teleported drawer) â€” used by the evidence card
//      row under each assistant message. Right-anchored on desktop,
//      bottom-sheet on mobile. Doesn't reflow the conversation.
//   2. TicketPanel (in-place right column) â€” used when the operator
//      taps a sorszam token in a message bubble. The conversation
//      reflows to a left column and the panel occupies the right
//      column at full viewport height. On mobile the panel becomes
//      a bottom sheet that overlays the conversation.
//
// Both surfaces take the same EvidenceTicket shape. The sorszam-click
// flow synthesises a ticket from just the sorszam (the wire doesn't
// expose a /ticket/:sorszam endpoint today, so fields we don't have
// render as "â€”").
// ---------------------------------------------------------------------------

const inspectorOpen = ref(false)
const inspectorTicket = ref<EvidenceTicket | null>(null)

/** Sorszam tapped in a message bubble â€” drives the in-place panel. */
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

function onSorszamClick(payload: { prefix: 'B' | 'M'; sorszam: string }) {
  // B-prefix: open the right-side ticket panel. The panel itself runs
  // a background useApi().answer() to fetch kategoria / sulyossag /
  // snippet from the first matching result row.
  //
  // M-prefix: route to /ask with the sorszam as the seed. M-IDs are
  // machine / device identifiers, not tickets â€” the cmms-api has no
  // /v1/tickets/:sorszam endpoint and the answer primitive is the
  // proper way to resolve a device query (it dispatches to
  // search_existing_tickets or device_tickets_list).
  if (payload.prefix === 'M') {
    setSeedQ(payload.sorszam)
    return
  }
  panelSorszam.value = payload.sorszam
  panelOpen.value = true
}

function closePanel() {
  panelOpen.value = false
}

// ---------------------------------------------------------------------------
// seedQ handoff (from Stream / Diff / Map "Show in Ask â†’" links)
// ---------------------------------------------------------------------------

onMounted(() => {
  const seed = consumeSeedQ()
  if (seed && seed.length > 0) {
    q.value = seed
    submitQuestion(seed)
  } else if (store.messages.length > 0) {
    // Page was opened on a thread with existing history — scroll to
    // the latest message so the user lands in the same place they
    // left off, not at the top of a long conversation.
    scrollToLatestMessage()
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
          <!-- Big hero input — desktop only. On mobile the docked
               composer at the bottom of the page is the input (so
               the user's thumb can reach it without scrolling), and
               this hero is just the greeting + chips. -->
          <div class="hidden md:block">
            <AskBar
              v-model="q"
              size="lg"
              rounded="lg"
              input-id="ask-input"
              placeholder="Kérdezd a CMMS-t…"
              :disabled="typing"
              @submit="submitQuestion"
            />
            <div class="flex justify-center mt-3">
              <AskThreadBar />
            </div>
          </div>
          <!-- Mobile: thread switcher sits in the hero (the docked
               composer at the bottom doesn't include it). -->
          <div class="md:hidden flex justify-center">
            <AskThreadBar />
          </div>
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
                  <div class="font-medium">
                    <SorszamLink :text="m.text" @sorszam-click="onSorszamClick" />
                  </div>
                  <div v-if="m.meta.error" class="text-xs text-rose-200/70 mt-1">
                    {{ m.meta.error }}
                  </div>
                </div>
              </div>

              <!-- Assistant: agentic answer (the current Ask path) -->
              <div
                v-else-if="m.meta?.agent"
                class="self-start max-w-[90%]"
                data-testid="assistant-agent"
              >
                <div class="flex items-baseline gap-2.5 mb-1">
                  <span class="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                    CMMS AI
                  </span>
                  <span class="font-mono text-[10px] text-text-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                </div>
                <div
                  class="bg-surface border border-border-subtle rounded-2xl rounded-tl-sm px-4 py-3"
                >
                  <AgentBody
                    :data="m.meta.agent"
                    @sorszam-click="onSorszamClick"
                  />
                </div>
              </div>

              <!-- Assistant: legacy deterministic answer (stored history) -->
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
                    @sorszam-click="onSorszamClick"
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
                    :aria-label="`Ticket ${t.sorszam} rĂ©szletei`"
                    :data-testid="`evidence-ticket-${t.sorszam}`"
                    @click="openTicket(t)"
                  >
                    <div class="font-mono text-[11px] text-accent">{{ t.sorszam }}</div>
                    <p class="mt-1 text-[12px] text-text-secondary line-clamp-2 leading-snug">
                      <SorszamLink :text="t.snippet" @sorszam-click="onSorszamClick" />
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
                Ăšjra
              </Button>
            </div>

            <!-- Typing indicator â€” pulsing AI icon while the agent works -->
            <div
              v-if="typing"
              class="self-start"
              data-testid="agent-thinking"
            >
              <div class="flex items-baseline gap-2.5 mb-1">
                <span class="text-[11px] font-medium text-text-muted uppercase tracking-wider">
                  CMMS AI
                </span>
              </div>
              <div
                class="bg-surface border border-border-subtle rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-2.5"
              >
                <!-- ChatGPT-style sparkle icon, pulsing while responding -->
                <svg
                  class="w-5 h-5 text-accent animate-pulse"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  data-testid="agent-thinking-icon"
                >
                  <path
                    d="M12 2.5l2.2 5.9 5.9 2.2-5.9 2.2L12 18.7l-2.2-5.9-5.9-2.2 5.9-2.2L12 2.5z"
                    fill="currentColor"
                  />
                  <circle cx="19" cy="5" r="1.4" fill="currentColor" opacity="0.7" />
                  <circle cx="5" cy="19" r="1.4" fill="currentColor" opacity="0.7" />
                </svg>
                <span class="text-xs text-text-secondary">Gondolkodomâ€¦</span>
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
    <!-- Docked-bottom composer (always on mobile, post-first-msg  -->
    <!-- on desktop)                                                  -->
    <!--                                                              -->
    <!-- Visibility:                                                   -->
    <!--   mobile + no messages yet  → SHOWN, size=lg (big input)    -->
    <!--   mobile + messages         → SHOWN, size=md (sticky)       -->
    <!--   desktop + no messages yet → HIDDEN (hero AskBar above)    -->
    <!--   desktop + messages        → SHOWN, size=md (sticky)       -->
    <!--                                                              -->
    <!-- The composer sits ABOVE the BottomTabs (which AppShell      -->
    <!-- reserves space for via `pb-16` on mobile). On notched      -->
    <!-- phones the safe-area-inset-bottom of the tab bar is         -->
    <!-- respected — pb-16 leaves exactly the bar's h-16.           -->
    <!-- ============================================================ -->
    <div
      v-if="isMobile || store.messages.length > 0"
      class="shrink-0 border-t border-border-subtle bg-canvas-2/90 backdrop-blur-xl"
      data-testid="ask-composer"
    >
      <div
        class="mx-auto w-full px-4 md:px-6 py-3"
        :class="[
          panelOpen ? 'max-w-4xl md:max-w-[calc(100vw-420px)]' : 'max-w-4xl',
          isMobile ? 'pb-[max(0.75rem,env(safe-area-inset-bottom))]' : '',
        ]"
      >
        <!-- Thread switcher is part of the desktop docked composer;
             on mobile it lives in the empty-state hero (above) so
             we don't double-render it. -->
        <div v-if="!isMobile" class="mb-2">
          <AskThreadBar />
        </div>
        <AskBar
          v-model="q"
          :size="composerSize"
          rounded="lg"
          :input-id="isMobile && store.messages.length === 0 ? 'ask-input-mobile-empty' : 'ask-input'"
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

