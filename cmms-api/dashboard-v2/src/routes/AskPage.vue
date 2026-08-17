<script setup lang="ts">
// src/routes/AskPage.vue
//
// V2 chat surface — the operator's main workspace.
//
// Layout:
//   - A single scrollable message region in the centre of the workspace,
//     with a maximum reading width of 860px on desktop and full width on
//     mobile.
//   - User messages align right with a subtle brand-tinted surface.
//     Assistant messages align left using 100% of the reading rail.
//   - A single docked composer at the bottom of the workspace when active,
//     or in the hero area when empty (NEVER double inputs on mobile).
//   - When a sorszam is tapped, the in-place right-side <TicketPanel>
//     opens in a column on desktop and as a bottom sheet on mobile.
//   - Scroll behaviour: only the message region scrolls. The composer
//     stays fixed.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import AgentBody from '@/components/AgentBody.vue'
import AskBar from '@/components/AskBar.vue'
import AskThreadBar from '@/components/AskThreadBar.vue'
import AnswerBody from '@/components/AnswerBody.vue'
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

const isMobile = useMediaQuery('(max-width: 767px)')

const composerSize = computed<'lg' | 'md'>(() => {
  if (isMobile.value && store.messages.length === 0) return 'lg'
  return 'md'
})

// ---------------------------------------------------------------------------
// Question state — vue-query manual trigger
// ---------------------------------------------------------------------------

const q = ref('')
const currentQ = ref('')
const run = ref(0)
const errorText = ref<string | null>(null)

const chatScroll = ref<HTMLElement | null>(null)
const userAtBottom = ref(true)

function detectLang(text: string): 'hu' | 'en' {
  return /[^\x00-\x7F]/.test(text) ? 'hu' : 'en'
}

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

function scrollToLatestMessage() {
  nextTick(() => {
    const scroller = chatScroll.value
    if (!scroller) return
    const messages = scroller.querySelectorAll(
      '[data-testid="user-message"], [data-testid="assistant-error"], [data-testid="assistant-agent"], [data-testid="assistant-answer"]',
    )
    const last = messages[messages.length - 1] as HTMLElement | undefined
    if (!last) {
      scroller.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    const containerRect = scroller.getBoundingClientRect()
    const msgRect = last.getBoundingClientRect()
    const delta = msgRect.top - containerRect.top
    const targetTop = scroller.scrollTop + delta - 24
    scroller.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
  })
}

function submitQuestion(text: string) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  currentQ.value = trimmed
  store.busy = true
  store.push({ role: 'user', text: trimmed, ts: Date.now() })
  q.value = ''
  run.value += 1
  // Record the thread this question was asked in so the answer lands
  // in the SAME thread even if the user has navigated to a different
  // chat by the time the response comes back.
  store.registerPendingRun(run.value, store.threadKey)
  errorText.value = null
  scrollToLatestMessage()
}

function runConfirmed(view: AnswerView) {
  currentQ.value = view.q
  store.busy = true
  store.push({ role: 'user', text: view.q, ts: Date.now() })
  run.value += 1
  store.registerPendingRun(run.value, store.threadKey)
  errorText.value = null
  scrollToLatestMessage()
}

function refineQuestion() {
  q.value = ''
  errorText.value = null
  nextTick(() => document.getElementById('ask-input')?.focus())
}

function onTicketOpenInAsk(sorszam: string) {
  if (!sorszam) return
  const text = `ticket ${sorszam}`
  q.value = text
  errorText.value = null
  nextTick(() => {
    const el = document.getElementById('ask-input') as HTMLInputElement | null
    el?.focus()
    el?.select?.()
  })
}

function retryLast() {
  if (currentQ.value.length === 0) return
  store.busy = true
  errorText.value = null
  run.value += 1
  // Re-register the submit thread for the retry — the original
  // pending entry was cleared when the error handler ran, and the
  // retry should re-anchor the next response to the thread the
  // user is currently looking at.
  store.registerPendingRun(run.value, store.threadKey)
}

function jumpToLatest() {
  scrollToLatestMessage()
}

// ---------------------------------------------------------------------------
// Scroll tracking — "Ugrás a legújabb" pill
// ---------------------------------------------------------------------------

function onScroll() {
  const el = chatScroll.value
  if (!el) return
  const distance = el.scrollHeight - el.clientHeight - el.scrollTop
  userAtBottom.value = distance < 80
}

let scrollEl: HTMLElement | null = null
watch(chatScroll, (el, prev) => {
  scrollEl = el
  if (prev) prev.removeEventListener('scroll', onScroll)
  if (el) el.addEventListener('scroll', onScroll, { passive: true })
})

// ---------------------------------------------------------------------------
// Query lifecycle → chat history
// ---------------------------------------------------------------------------

let handledRun = 0

watch(query.data, (data) => {
  if (!data || handledRun >= run.value) return
  handledRun = run.value
  store.busy = false
  // Route the answer to the right thread. The thread the question was
  // ASKED in (submitKey) is the anchor — if the user has navigated
  // away mid-flight, we land the answer there and DON'T teleport them
  // back. Otherwise we honour the existing auto-split behaviour
  // (move the user question + answer to the resolved customer thread).
  const submitKey = store.consumePendingRun(run.value) ?? store.threadKey
  const route = store.pickThreadForAnswer(data, submitKey)
  if (route.shouldSwitchActive) {
    // Auto-split: move the trailing (unanswered) user question from
    // the source thread to the resolved customer thread before we
    // switch the active thread.
    store.moveTrailingQuestion(submitKey, route.threadKey)
    store.switchThread(route.threadKey)
  }
  store.pushForThread(route.threadKey, {
    role: 'assistant',
    text: data.final_text,
    ts: Date.now(),
    meta: { agent: data },
  })
  store.clearPendingRun(run.value)
  if (userAtBottom.value) {
    scrollToLatestMessage()
  }
})

watch(query.isError, (isErr) => {
  if (!isErr || handledRun >= run.value) return
  handledRun = run.value
  store.busy = false
  const h = humanizeError(query.error.value)
  errorText.value = h.description
  // Errors have no resolved customer — write the error to the submit
  // thread and don't auto-split. The user can see the failure in the
  // thread they asked the question in.
  const submitKey = store.consumePendingRun(run.value) ?? store.threadKey
  store.pushForThread(submitKey, {
    role: 'assistant',
    text: h.title,
    ts: Date.now(),
    meta: { error: h.description },
  })
  store.clearPendingRun(run.value)
  if (userAtBottom.value) {
    scrollToLatestMessage()
  }
})

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

function asTicket(row: EvidenceRow): EvidenceTicket {
  return {
    sorszam: row.sorszam,
    key: row.sorszam,
    reported_at_iso: '',
    snippet: row.snippet,
    kategoria: row.kategoria,
    kategoria_inferred: null,
    sulyossag_inferred: null,
  }
}

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
// ---------------------------------------------------------------------------

const inspectorOpen = ref(false)
const inspectorTicket = ref<EvidenceTicket | null>(null)

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
// seedQ handoff
// ---------------------------------------------------------------------------

onMounted(() => {
  const seed = consumeSeedQ()
  if (seed && seed.length > 0) {
    q.value = seed
    submitQuestion(seed)
  } else if (store.messages.length > 0) {
    scrollToLatestMessage()
  }
})

onBeforeUnmount(() => {
  if (scrollEl) scrollEl.removeEventListener('scroll', onScroll)
})
</script>

<template>
  <div class="h-full flex flex-col min-h-0 relative overflow-hidden" data-testid="ask-page">
    <!-- ============================================================ -->
    <!-- Chat scroll area (single owned scroll container)             -->
    <!-- ============================================================ -->
    <div
      ref="chatScroll"
      class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pt-6 pb-[calc(3.5rem+env(safe-area-inset-bottom)+1.5rem)] md:py-6"
      data-testid="ask-scroll"
    >
      <!-- Empty state -->
      <div
        v-if="store.messages.length === 0"
        class="min-h-full flex items-center justify-center py-8"
        data-testid="ask-empty"
      >
        <div class="w-full max-w-[860px] mx-auto space-y-8 text-center">
          <!-- Greeting -->
          <div class="space-y-3">
            <div
              class="inline-flex items-center gap-2 px-3 py-1 rounded-full
                     bg-shell-rail-elevated border border-shell-rail-border
                     text-[11px] font-mono uppercase tracking-wider text-shell-rail-muted"
              data-testid="ask-empty-chip"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-nct-soft" aria-hidden="true" />
              NCT Szerviz Ai · v2
            </div>
            <h1
              class="text-[26px] md:text-[32px] font-semibold tracking-tight text-chat-read-text leading-tight"
              data-testid="ask-greeting"
            >
              {{ greeting }}
            </h1>
            <p
              class="text-[14px] text-chat-read-muted max-w-lg mx-auto leading-relaxed"
              data-testid="ask-empty-tagline"
            >
              Belső karbantartási asszisztens — ticketek, gépek, ügyfelek,
              visszatérő minták. A CMMS adataiból dolgozik, magyarul válaszol.
            </p>
          </div>

          <!-- Hero composer (SINGLE input on empty state) -->
          <div class="max-w-2xl mx-auto w-full space-y-3">
            <AskBar
              v-model="q"
              size="lg"
              rounded="lg"
              input-id="ask-input"
              placeholder="Kérdezd a NCT Szerviz Ai-t…"
              :disabled="typing"
              @submit="submitQuestion"
            />
            <div class="md:hidden flex justify-center">
              <AskThreadBar />
            </div>
          </div>

          <!-- Starter chips -->
          <div class="flex flex-wrap justify-center gap-2 max-w-2xl mx-auto pt-1">
            <button
              v-for="chip in EXAMPLE_CHIPS"
              :key="chip"
              type="button"
              class="h-8 px-3.5 rounded-full
                     bg-shell-rail-elevated border border-shell-rail-border
                     text-[12.5px] text-chat-read-text/90
                     hover:text-chat-read-text hover:border-nct-soft/50
                     transition-colors duration-150
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
              data-testid="example-chip"
              @click="submitQuestion(chip)"
            >
              {{ chip }}
            </button>
          </div>
        </div>
      </div>

      <!-- Active conversation -->
      <div
        v-else
        class="w-full flex"
        :class="panelOpen ? 'flex-col md:flex-row gap-6' : 'block'"
        data-testid="ask-conversation-wrapper"
      >
        <div
          class="flex-1 min-w-0"
          data-testid="ask-conversation-column"
        >
          <div
            class="mx-auto w-full max-w-[860px] flex flex-col gap-6 pb-12"
          >
            <template v-for="(m, idx) in store.messages" :key="idx">
              <!-- User message -->
              <div
                v-if="m.role === 'user'"
                class="self-end max-w-[85%] md:max-w-[70%] flex flex-col items-end gap-1.5"
                data-testid="user-message"
              >
                <div class="flex items-baseline gap-2 justify-end px-1">
                  <span class="font-mono text-[10px] text-chat-read-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                  <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider">
                    Te
                  </span>
                </div>
                <div
                  class="bg-shell-message-user border border-shell-message-user-border
                         rounded-2xl rounded-tr-sm px-4 py-3
                         text-[14.5px] text-chat-read-text leading-relaxed shadow-sm"
                >
                  <SorszamLink :text="m.text" @sorszam-click="onSorszamClick" />
                </div>
              </div>

              <!-- Assistant: error bubble -->
              <div
                v-else-if="m.meta?.error"
                class="self-start w-full flex flex-col items-start gap-1.5"
                data-testid="assistant-error"
              >
                <div class="flex items-baseline gap-2 px-1">
                  <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider font-mono">
                    NCT Szerviz Ai
                  </span>
                  <span class="font-mono text-[10px] text-chat-read-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                </div>
                <div
                  class="w-full bg-danger/[0.08] border border-danger/25
                         rounded-2xl rounded-tl-sm px-5 py-4 text-[14px] text-danger"
                >
                  <div class="font-medium">
                    <SorszamLink :text="m.text" @sorszam-click="onSorszamClick" />
                  </div>
                  <div v-if="m.meta.error" class="text-xs opacity-80 mt-1">
                    {{ m.meta.error }}
                  </div>
                </div>
              </div>

              <!-- Assistant: agentic answer -->
              <div
                v-else-if="m.meta?.agent"
                class="self-start w-full flex flex-col items-start gap-1.5"
                data-testid="assistant-agent"
              >
                <div class="flex items-baseline gap-2 px-1">
                  <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider font-mono">
                    NCT Szerviz Ai
                  </span>
                  <span class="font-mono text-[10px] text-chat-read-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                </div>
                <div
                  class="w-full bg-shell-message-assistant border border-shell-message-border
                         rounded-2xl rounded-tl-sm px-5 py-4 text-chat-read-text shadow-sm"
                >
                  <AgentBody
                    :data="m.meta.agent"
                    @sorszam-click="onSorszamClick"
                  />
                </div>
              </div>

              <!-- Assistant: legacy deterministic answer -->
              <div
                v-else-if="m.meta?.answer"
                class="self-start w-full flex flex-col items-start gap-1.5"
                data-testid="assistant-answer"
              >
                <div class="flex items-baseline gap-2 px-1">
                  <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider font-mono">
                    NCT Szerviz Ai
                  </span>
                  <span class="font-mono text-[10px] text-chat-read-muted tabular-nums">
                    {{ fmtTime(m.ts) }}
                  </span>
                </div>
                <div
                  class="w-full bg-shell-message-assistant border border-shell-message-border
                         rounded-2xl rounded-tl-sm px-5 py-4 text-chat-read-text shadow-sm"
                >
                  <AnswerBody
                    :data="m.meta.answer"
                    @run="runConfirmed"
                    @refine="refineQuestion"
                    @followup="submitQuestion"
                    @sorszam-click="onSorszamClick"
                  />
                </div>

                <div
                  v-if="evidenceFor(m.meta.answer).length > 0"
                  class="w-full mt-2 flex gap-2 overflow-x-auto px-1 pb-1 snap-x"
                  data-testid="evidence-card-row"
                >
                  <button
                    v-for="t in evidenceFor(m.meta.answer)"
                    :key="t.sorszam"
                    type="button"
                    class="snap-start shrink-0 w-60 text-left
                           bg-shell-message-assistant hover:bg-shell-rail-hover
                           border border-shell-message-border hover:border-nct-soft/40
                           rounded-lg px-3 py-2.5
                           transition-colors duration-150
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
                    :aria-label="`Ticket ${t.sorszam} részletei`"
                    :data-testid="`evidence-ticket-${t.sorszam}`"
                    @click="openTicket(t)"
                  >
                    <div class="font-mono text-[11px] text-nct-soft font-medium">{{ t.sorszam }}</div>
                    <p class="mt-1 text-[12px] text-chat-read-muted line-clamp-2 leading-snug">
                      <SorszamLink :text="t.snippet" @sorszam-click="onSorszamClick" />
                    </p>
                    <div
                      v-if="t.kategoria"
                      class="mt-1.5 text-[10px] font-mono uppercase tracking-wider text-chat-read-muted"
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
              class="self-start bg-danger/[0.08] border border-danger/25 rounded-lg px-4 py-3 text-[13px] text-danger flex items-center justify-between gap-3 w-full"
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
              class="self-start w-full flex flex-col items-start gap-1.5"
              data-testid="agent-thinking"
            >
              <div class="flex items-baseline gap-2 px-1">
                <span class="text-[10px] font-medium text-chat-read-muted uppercase tracking-wider font-mono">
                  NCT Szerviz Ai
                </span>
              </div>
              <div
                class="bg-shell-message-assistant border border-shell-message-border
                       rounded-2xl rounded-tl-sm px-5 py-3.5 flex items-center gap-2.5 shadow-sm"
              >
                <svg
                  class="w-4 h-4 text-nct-soft animate-nct-pulse-glow"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                  data-testid="agent-thinking-icon"
                >
                  <path
                    d="M12 2.5l2.2 5.9 5.9 2.2-5.9 2.2L12 18.7l-2.2-5.9-5.9-2.2 5.9-2.2L12 2.5z"
                  />
                </svg>
                <span class="text-[13px] text-chat-read-muted font-medium">Gondolkodom…</span>
                <div class="flex items-center gap-1 ml-1">
                  <span class="w-1 h-1 rounded-full bg-nct-soft animate-nct-blink" style="animation-delay: 0ms" />
                  <span class="w-1 h-1 rounded-full bg-nct-soft animate-nct-blink" style="animation-delay: 150ms" />
                  <span class="w-1 h-1 rounded-full bg-nct-soft animate-nct-blink" style="animation-delay: 300ms" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- In-place right column.
             The panel sticks to the top of the conversation scroll and
             bounds itself to the visible viewport (calc(100dvh - 52px topbar)
             on desktop, 85dvh on mobile) so the user never has to scroll
             the chat back up to find the ticket header. -->
        <TicketPanel
          v-if="panelOpen"
          :open="panelOpen"
          :ticket="panelTicket"
          class="md:w-[420px] shrink-0 md:self-start"
          @update:open="closePanel"
          @open-in-ask="onTicketOpenInAsk"
        />
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- "Jump to latest" pill (when user scrolled away from bottom)  -->
    <!-- ============================================================ -->
    <Transition
      enter-active-class="transition-all duration-200 ease-out"
      leave-active-class="transition-all duration-200 ease-in"
      enter-from-class="opacity-0 translate-y-2"
      leave-to-class="opacity-0 translate-y-2"
    >
      <button
        v-if="!userAtBottom && store.messages.length > 0 && !isMobile"
        type="button"
        class="absolute bottom-24 left-1/2 -translate-x-1/2 z-20
               inline-flex items-center gap-1.5 h-8 px-3.5
               bg-surface border border-border-default
               rounded-full shadow-lg shadow-black/20
               text-[12px] font-medium text-text-primary
               hover:bg-surface-2 hover:border-border-strong
               focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60
               transition-colors duration-150"
        data-testid="ask-jump-latest"
        @click="jumpToLatest"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 3v9M4 9l4 4 4-4"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span>Ugrás a legújabbhoz</span>
      </button>
    </Transition>

    <!-- ============================================================ -->
    <!-- Docked-bottom composer (ONLY when conversation is active)   -->
    <!-- On mobile the bottom tab bar (BottomTabs, h-14 + safe-area) -->
    <!-- is `fixed bottom-0 z-40` and would otherwise slide under or  -->
    <!-- cover the composer. We lift the composer above it with a     -->
    <!-- matching bottom margin. On `md+` the BottomTabs is `hidden`  -->
    <!-- so this margin is removed.                                   -->
    <!-- ============================================================ -->
    <div
      v-if="store.messages.length > 0"
      class="shrink-0 border-t border-shell-divider bg-shell-composer/95 backdrop-blur-xl relative z-10 px-3 md:px-4 py-3 mb-[calc(3.5rem+env(safe-area-inset-bottom))] md:mb-0"
      data-testid="ask-composer"
    >
      <div
        class="mx-auto w-full"
        :class="[
          panelOpen ? 'max-w-[860px] md:max-w-[calc(100vw-460px)]' : 'max-w-[860px]',
          isMobile ? 'pb-[max(0.5rem,env(safe-area-inset-bottom))]' : '',
        ]"
      >
        <div class="flex items-center justify-between gap-2 px-1 mb-1.5">
          <div class="md:hidden min-w-0">
            <AskThreadBar />
          </div>
          <span class="md:ml-auto text-[10.5px] font-mono text-chat-read-muted">
            {{ store.index.length }} beszélgetés
          </span>
        </div>
        <div
          class="rounded-2xl bg-surface border border-border-default
                 shadow-[0_2px_12px_rgba(0,0,0,0.08)]
                 px-1.5 py-1.5
                 focus-within:border-nct-soft focus-within:ring-2 focus-within:ring-nct-soft/20
                 transition-colors duration-200"
        >
          <AskBar
            v-model="q"
            :size="composerSize"
            rounded="lg"
            input-id="ask-input"
            placeholder="Kérdezd a NCT Szerviz Ai-t…"
            :disabled="typing"
            :busy="typing"
            @submit="submitQuestion"
          />
        </div>
        <div class="mt-1.5 px-1 flex items-center justify-between text-[10.5px] text-chat-read-muted font-mono">
          <span class="hidden sm:inline">Enter a küldéshez · Shift+Enter új sor</span>
          <span class="sm:hidden">Enter a küldéshez</span>
          <span class="text-chat-read-muted/80">NCT Szerviz Ai · v2</span>
        </div>
      </div>
    </div>

    <!-- Ticket inspector (right-drawer on desktop, bottom sheet on mobile) -->
    <TicketInspector
      :open="inspectorOpen"
      :ticket="inspectorTicket"
      @update:open="closeInspector"
      @open-in-ask="onTicketOpenInAsk"
    />
  </div>
</template>
