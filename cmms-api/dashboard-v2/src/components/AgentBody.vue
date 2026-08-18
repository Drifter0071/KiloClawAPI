<script setup lang="ts">
// src/components/AgentBody.vue
//
// Renders an agentic answer (POST /v1/answer-agent response):
//   - final_text — the LLM's answer, with inline markdown (**bold**,
//     *italic*, `code`) styled AND sorszam tokens clickable
//   - tool-trace chips — every tool the agent called, ok / failed
//   - meta line — iteration count + model
//   - ticket_cards — when the agent's last answer_question call
//     returned a results list, we surface it here as clickable
//     cards. The LLM never has to enumerate >4 tickets inline —
//     that loses entries to the token budget (e.g. M17191 had 12
//     tickets but the LLM only listed 8).
//   - vote-bar — the like / dislike footer (right-aligned). Hidden
//     when there is no `answer_id` (legacy deterministic answer).
//
// This is the CURRENT Ask path (always on). The legacy AnswerBody only
// renders stored history entries (meta.answer).

import { computed, ref } from 'vue'
import SorszamLink from './SorszamLink.vue'
import AnswerVoteBar from './AnswerVoteBar.vue'
import type { AnswerAgentResponse, AgentTicketCard } from '@/lib/api'

const props = defineProps<{
  data: AnswerAgentResponse
  /** When true, the vote bar is disabled (assistant is still streaming
   *  or we want to keep it inert while the user reads). */
  voteDisabled?: boolean
  /** Pre-hydrated vote from the my-votes batch endpoint. */
  initialVote?: -1 | 0 | 1
}>()

const emit = defineEmits<{
  (e: 'sorszam-click', payload: { prefix: 'B' | 'M'; sorszam: string }): void
  (
    e: 'ticket-card-click',
    payload: { sorszam: string; card: AgentTicketCard },
  ): void
  (
    e: 'vote-submitted',
    payload: { answerId: string; vote: -1 | 0 | 1; reason?: string },
  ): void
}>()

type InlineSeg = { kind: 'plain' | 'bold' | 'italic' | 'code'; text: string }

/** Split final_text into inline-markdown segments (bold/italic/code)
 *  while leaving everything else as plain text. Sorszam tokenization
 *  happens per segment inside SorszamLink, so ids stay clickable even
 *  inside a **bold** run. */
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g

const segments = computed<InlineSeg[]>(() => {
  const out: InlineSeg[] = []
  const text = props.data.final_text
  let last = 0
  INLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'plain', text: text.slice(last, m.index) })
    const tok = m[0]
    if (tok.startsWith('**')) out.push({ kind: 'bold', text: tok.slice(2, -2) })
    else if (tok.startsWith('`')) out.push({ kind: 'code', text: tok.slice(1, -1) })
    else out.push({ kind: 'italic', text: tok.slice(1, -1) })
    last = m.index + tok.length
  }
  if (last < text.length) out.push({ kind: 'plain', text: text.slice(last) })
  return out
})

// ---------------------------------------------------------------------------
// Ticket cards
// ---------------------------------------------------------------------------
//
// When the agent's last answer_question call returned a results list,
// `data.ticket_cards` is the full structured list (sorszam + date +
// customer + kategoria + snippet). We render the FIRST N as visible
// cards and collapse the rest behind a "Show all N" disclosure. The
// cap is generous — the LLM prose already had room to cite the
// highlights; the cards are the source of truth for the rest.

const VISIBLE_CARD_LIMIT = 20

const cards = computed<AgentTicketCard[]>(() => props.data.ticket_cards ?? [])
const hasOverflow = computed(() => cards.value.length > VISIBLE_CARD_LIMIT)
const expanded = ref(false)
const visibleCards = computed<AgentTicketCard[]>(() =>
  expanded.value ? cards.value : cards.value.slice(0, VISIBLE_CARD_LIMIT),
)
const overflowCount = computed(() => cards.value.length - VISIBLE_CARD_LIMIT)

function fmtCardDate(iso: string | null): string {
  if (!iso) return ''
  // The server emits ISO 8601 (with time) for reported_at_iso. The
  // card is small, so a compact yyyy-mm-dd is plenty.
  return iso.slice(0, 10)
}

function kategoriaLabel(c: AgentTicketCard): string | null {
  return c.kategoria && c.kategoria !== 'Egyeb' ? c.kategoria : c.kategoria_inferred
}

function sulyossagLabel(c: AgentTicketCard): string | null {
  if (!c.sulyossag_inferred) return null
  if (c.sulyossag_inferred === 'kritikus') return 'kritikus'
  if (c.sulyossag_inferred === 'magas') return 'magas'
  if (c.sulyossag_inferred === 'kozepes') return 'közepes'
  if (c.sulyossag_inferred === 'alacsony') return 'alacsony'
  return c.sulyossag_inferred
}

function onCardClick(card: AgentTicketCard) {
  // Route through the same sorszam-click channel as inline text links
  // — the parent's single openTicketInspector() flow opens the shared
  // ticket inspector (bottom sheet on mobile, right drawer on
  // desktop). No duplicate ticket-detail logic; the card payload is
  // also emitted for callers that want the metadata.
  const prefix: 'B' | 'M' = card.sorszam.startsWith('M-') || card.sorszam.startsWith('M2')
    ? 'M'
    : 'B'
  emit('sorszam-click', { prefix, sorszam: card.sorszam })
  emit('ticket-card-click', { sorszam: card.sorszam, card })
}
</script>

<template>
  <div data-testid="agent-body">
    <div
      class="text-[15px] text-text-primary leading-relaxed whitespace-pre-wrap min-w-0 break-words [overflow-wrap:anywhere]"
      data-testid="agent-body-text"
    >
      <template v-for="(seg, i) in segments" :key="i">
        <strong v-if="seg.kind === 'bold'" class="font-semibold">
          <SorszamLink :text="seg.text" @sorszam-click="emit('sorszam-click', $event)" />
        </strong>
        <em v-else-if="seg.kind === 'italic'" class="italic">
          <SorszamLink :text="seg.text" @sorszam-click="emit('sorszam-click', $event)" />
        </em>
        <code
          v-else-if="seg.kind === 'code'"
          class="px-1 py-0.5 rounded bg-surface-2 border border-border-subtle font-mono text-[13px]"
        >
          <SorszamLink :text="seg.text" @sorszam-click="emit('sorszam-click', $event)" />
        </code>
        <SorszamLink v-else :text="seg.text" @sorszam-click="emit('sorszam-click', $event)" />
      </template>
    </div>

    <!-- Ticket cards (when the agent's answer_question call returned
         a results list). The LLM prose above is the summary; these
         are the clickable details. -->
    <div
      v-if="cards.length > 0"
      class="mt-4 space-y-2"
      data-testid="agent-ticket-cards"
    >
      <div
        class="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-text-muted"
        data-testid="agent-ticket-cards-header"
      >
        <span
          class="w-1 h-1 rounded-full bg-nct-soft"
          aria-hidden="true"
        />
        <span>
          {{ cards.length }} jegy
        </span>
      </div>

      <ul class="space-y-1.5" data-testid="agent-ticket-cards-list">
        <li
          v-for="card in visibleCards"
          :key="card.sorszam"
        >
          <button
            type="button"
            class="w-full text-left
                   bg-surface hover:bg-surface-2
                   border border-border-subtle hover:border-nct-soft/50
                   rounded-lg px-3 py-2.5
                   transition-colors duration-150
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/60"
            :data-testid="`agent-ticket-card-${card.sorszam}`"
            @click="onCardClick(card)"
          >
            <div class="flex flex-wrap items-center gap-2 min-w-0">
              <span
                class="font-mono text-[12.5px] font-semibold text-nct-soft shrink-0"
              >
                {{ card.sorszam }}
              </span>
              <span
                v-if="card.status"
                class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider shrink-0"
                :class="
                  card.status === 'open'
                    ? 'bg-nct-500/10 text-nct-soft border border-nct-soft/30'
                    : 'bg-surface-2 text-text-muted border border-border-subtle'
                "
                :data-testid="`agent-ticket-card-status-${card.sorszam}`"
              >
                <span
                  class="w-1 h-1 rounded-full"
                  :class="card.status === 'open' ? 'bg-nct-soft' : 'bg-text-muted'"
                  aria-hidden="true"
                />
                {{ card.status === 'open' ? 'nyitott' : 'lezárt' }}
              </span>
              <span
                v-if="kategoriaLabel(card)"
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium text-text-secondary bg-surface-2 border border-border-subtle shrink-0"
                :data-testid="`agent-ticket-card-kategoria-${card.sorszam}`"
              >
                {{ kategoriaLabel(card) }}
              </span>
              <span
                v-if="sulyossagLabel(card)"
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider shrink-0"
                :class="
                  sulyossagLabel(card) === 'kritikus' || sulyossagLabel(card) === 'magas'
                    ? 'bg-danger/10 text-danger border border-danger/30'
                    : 'bg-surface-2 text-text-muted border border-border-subtle'
                "
                :data-testid="`agent-ticket-card-sulyossag-${card.sorszam}`"
              >
                {{ sulyossagLabel(card) }}
              </span>
              <span
                v-if="fmtCardDate(card.reported_at_iso)"
                class="font-mono text-[10px] text-text-muted tabular-nums shrink-0 ml-auto"
              >
                {{ fmtCardDate(card.reported_at_iso) }}
              </span>
            </div>
            <div class="mt-1.5 flex items-baseline gap-2 min-w-0">
              <span
                v-if="card.customer_name"
                class="text-[12px] font-medium text-text-primary truncate"
              >
                {{ card.customer_name }}
              </span>
              <span
                v-if="card.device"
                class="font-mono text-[10.5px] text-text-muted shrink-0"
              >
                · {{ card.device }}
              </span>
            </div>
            <p
              v-if="card.snippet"
              class="mt-1 text-[12.5px] text-text-secondary leading-snug line-clamp-2"
            >
              {{ card.snippet }}
            </p>
          </button>
        </li>
      </ul>

      <button
        v-if="hasOverflow"
        type="button"
        class="text-[11px] font-mono text-nct-soft hover:text-nct-500
               focus:outline-none focus-visible:underline"
        data-testid="agent-ticket-cards-show-all"
        @click="expanded = !expanded"
      >
        {{
          expanded
            ? `Kevesebb mutatása`
            : `Összes megjelenítése (+${overflowCount})`
        }}
      </button>
    </div>

    <!-- Tool trace chips -->
    <div
      v-if="data.tool_trace.length > 0"
      class="mt-3 flex flex-wrap gap-1.5"
      data-testid="agent-trace"
    >
      <span
        v-for="(t, i) in data.tool_trace"
        :key="`${t.name}-${i}`"
        class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-surface-2 border border-border-subtle font-mono text-[10px]"
        :class="t.ok ? 'text-text-secondary' : 'text-danger border-danger/40'"
        :data-testid="`agent-trace-${t.name}`"
        :title="t.ok ? '' : (t.note ?? 'hiba')"
      >
        <span
          class="w-1 h-1 rounded-full shrink-0"
          :class="t.ok ? 'bg-emerald-400' : 'bg-rose-400 animate-pulse'"
        />
        {{ t.name }}
        <span v-if="!t.ok" class="text-[9px]" aria-hidden="true">✗</span>
      </span>
    </div>

    <div
      class="mt-2 flex items-center gap-2 text-[10px] font-mono text-text-muted"
      data-testid="agent-meta"
    >
      <span>{{ data.iterations }} lépés</span>
      <span aria-hidden="true">·</span>
      <span>{{ data.model }}</span>
    </div>

    <!-- Like / dislike bar. Hidden when the response has no
         answer_id (legacy deterministic answer, mock fixtures). The
         bar re-emits 'vote-submitted' so the parent can refresh
         counters or analytics without polling. -->
    <div v-if="data.answer_id" class="mt-2">
      <AnswerVoteBar
        :answer-id="data.answer_id"
        :disabled="voteDisabled"
        :initial-vote="initialVote ?? 0"
        @vote-submitted="(p) => emit('vote-submitted', p)"
      />
    </div>
  </div>
</template>
