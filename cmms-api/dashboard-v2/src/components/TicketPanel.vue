<script setup lang="ts">
// src/components/TicketPanel.vue
//
// In-place right-column ticket panel (HIG inspector variant).
//
// Used by the Ask page when the operator taps a B-prefix sorszam in
// a message bubble. Lives inside the page layout (not teleported) so
// the conversation column reflows to the left and the panel occupies
// the right column at full viewport height.
//
// On mobile (< md) the panel becomes a bottom sheet that slides up
// from below the conversation (same pattern as TicketInspector, just
// without the body-teleport).
//
// Data flow:
//   - The parent passes a synthetic EvidenceTicket (sorszam only;
//     all other fields blank) on `open: true`.
//   - On open, we fire a useApi().answer({ sorszam, q: 'ticket <id>' })
//     query in the background. The first matching result row's
//     kategoria / sulyossag_inferred / snippet / reported_at
//     overrides the placeholder fields, so the panel populates
//     without a dedicated /v1/tickets/:sorszam endpoint.
//   - M-prefix sorszams (machines) are NOT opened in this panel —
//     the parent (AskPage) routes them to /ask via setSeedQ instead.
//
// Emits:
//   update:open(value)  — user closed the panel (X, Escape, or "Bezárás")
//   openInAsk(sorszam)  — user clicked "Megnyitás Ask-ban" CTA

import { computed, onBeforeUnmount, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { EvidenceTicket, AnswerResponse, AnswerRequest } from '@/lib/api'
import Button from '@/components/Button.vue'
import Skeleton from '@/components/Skeleton.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { setSeedQ } from '@/composables/useSeedQ'

const props = defineProps<{
  open: boolean
  ticket: EvidenceTicket | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'openInAsk', sorszam: string): void
}>()

function close() {
  emit('update:open', false)
}

function onKeydown(evt: KeyboardEvent) {
  if (evt.key === 'Escape' && props.open) {
    evt.stopPropagation()
    close()
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (typeof document === 'undefined') return
    if (isOpen) document.addEventListener('keydown', onKeydown)
    else document.removeEventListener('keydown', onKeydown)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('keydown', onKeydown)
})

// ---------------------------------------------------------------------------
// Background fetch: ask the cmms-api for the ticket's full record.
//
// We use the existing answer endpoint with the sorszam filter rather
// than adding a dedicated /v1/tickets/:sorszam endpoint today. The
// endpoint is /v1/answer (proxied via /dashboard/api/answer) — we
// send `q: "ticket <id>"` to give the router enough context to
// dispatch to search_existing_tickets, plus the explicit sorszam
// filter so the router short-circuits the disambiguation step.
// ---------------------------------------------------------------------------

const lookupKey = computed(() => {
  if (!props.open || !props.ticket?.sorszam) return null
  return `lookup-${props.ticket.sorszam}`
})

const ticketQuery = useQuery({
  queryKey: ['ticket-panel-lookup', lookupKey],
  queryFn: withAutoRetry(async (): Promise<AnswerResponse | null> => {
    if (!props.ticket?.sorszam) return null
    // The wire-level AnswerFilters type accepts sorszam as a filter;
    // AnswerRequest omits it (the typed view derives sorszam from q +
    // confirm-mode). For the ticket-panel lookup we bypass the
    // request shape and pass sorszam through as a string-key filter,
    // mirroring how runConfirmed() carries confirm-mode filters.
    const req = {
      q: `ticket ${props.ticket.sorszam}`,
      sorszam: props.ticket.sorszam,
      language: 'hu',
    }
    return useApi().answer(req as unknown as AnswerRequest)
  }),
  enabled: computed(() => !!lookupKey.value),
})

interface ResolvedTicket {
  reported_at_iso: string
  kategoria: string | null
  sulyossag_inferred: string | null
  snippet: string
  /** Best-effort human label derived from the result row (snippet / model / customer). */
  primary: string
}

/** Project the answer response into a structured ticket view. */
const resolved = computed<ResolvedTicket | null>(() => {
  const r = ticketQuery.data.value
  if (!r) return null
  const first = r.results?.[0]
  if (!first || typeof first !== 'object' || first === null) return null
  const row = first as Record<string, unknown>
  const snippet =
    (typeof row.snippet === 'string' && row.snippet) ||
    (typeof row.notes === 'string' && row.notes) ||
    (typeof row.leiras === 'string' && row.leiras) ||
    (typeof row.summary === 'string' && row.summary) ||
    (typeof row.text === 'string' && row.text) ||
    ''
  const kategoria =
    (typeof row.kategoria === 'string' && row.kategoria) ||
    (typeof row.kategoria_inferred === 'string' && row.kategoria_inferred) ||
    null
  const sulyossag =
    (typeof row.sulyossag_inferred === 'string' && row.sulyossag_inferred) ||
    (typeof row.sulyossag === 'string' && row.sulyossag) ||
    null
  const primary =
    (typeof row.sorszam === 'string' && row.sorszam) ||
    (typeof row.model === 'string' && row.model) ||
    (typeof row.customer === 'string' && row.customer) ||
    (typeof row.name === 'string' && row.name) ||
    snippet.slice(0, 60) ||
    ''
  return {
    reported_at_iso: '',
    kategoria,
    sulyossag_inferred: sulyossag,
    snippet,
    primary,
  }
})

const isLoading = computed(() => ticketQuery.isFetching.value)
const hasResolved = computed(() => resolved.value !== null)

function fmtTimestamp(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}. ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const reportedAt = computed(
  () => fmtTimestamp(resolved.value?.reported_at_iso) || '—',
)
const kategoria = computed(
  () => resolved.value?.kategoria ?? props.ticket?.kategoria ?? '—',
)
const sulyossag = computed(
  () => resolved.value?.sulyossag_inferred ?? props.ticket?.sulyossag_inferred ?? '—',
)
const snippet = computed(
  () => resolved.value?.snippet || props.ticket?.snippet || '—',
)
const ticketLabel = computed(
  () => resolved.value?.primary || props.ticket?.sorszam || '—',
)

function openInAsk() {
  if (!props.ticket) return
  setSeedQ(`ticket ${props.ticket.sorszam}`)
  emit('openInAsk', props.ticket.sorszam)
  close()
}

function copySorszam() {
  const s = props.ticket?.sorszam
  if (!s || typeof navigator === 'undefined') return
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(s)
  }
}
</script>

<template>
  <aside
    v-if="open"
    class="
      flex flex-col
      bg-canvas-2 border-border-default
      md:rounded-l-xl md:border-l md:border-y md:border-r-0
      md:shadow-[-8px_0_24px_rgba(0,0,0,0.30)]
      rounded-t-2xl border-t border-x
      shrink-0
    "
    role="complementary"
    :aria-label="ticket ? `Ticket ${ticket.sorszam}` : 'Ticket részletek'"
    data-testid="ticket-panel"
  >
    <header
      class="px-5 pt-4 pb-3 border-b border-border-subtle flex items-start justify-between gap-3 shrink-0"
    >
      <div class="min-w-0">
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
          Ticket
        </div>
        <button
          type="button"
          class="mt-0.5 font-mono text-[15px] font-semibold text-accent hover:text-accent-hover transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
          :aria-label="`Sorszám másolása: ${ticket?.sorszam ?? ''}`"
          data-testid="ticket-panel-sorszam"
          @click="copySorszam"
        >
          {{ ticket?.sorszam ?? '—' }}
        </button>
        <div
          v-if="hasResolved && ticketLabel !== ticket?.sorszam"
          class="mt-1 text-[12px] text-text-secondary truncate"
          data-testid="ticket-panel-primary"
        >
          {{ ticketLabel }}
        </div>
      </div>
      <button
        type="button"
        class="w-7 h-7 -mr-1 rounded-md border border-border-subtle bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label="Bezárás"
        data-testid="ticket-panel-close"
        @click="close"
      >
        <svg
          class="w-3.5 h-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </header>

    <div class="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4 text-sm">
      <!-- Loading skeleton while the background fetch is in flight. -->
      <div
        v-if="isLoading && !hasResolved"
        class="space-y-3"
        data-testid="ticket-panel-loading"
      >
        <div class="grid grid-cols-2 gap-3">
          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Bejelentve
            </div>
            <Skeleton h="h-4" w="w-28" class="mt-1" />
          </div>
          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Kategória
            </div>
            <Skeleton h="h-4" w="w-24" class="mt-1" />
          </div>
          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Súlyosság
            </div>
            <Skeleton h="h-4" w="w-20" class="mt-1" />
          </div>
          <div v-if="ticket?.key">
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Kulcs
            </div>
            <Skeleton h="h-4" w="w-32" class="mt-1" />
          </div>
        </div>
        <div>
          <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
            Leírás
          </div>
          <Skeleton h="h-4" w="w-full" />
          <Skeleton h="h-4" w="w-3/4" class="mt-1" />
        </div>
      </div>

      <template v-else>
        <div class="grid grid-cols-2 gap-3" data-testid="ticket-panel-meta">
          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Bejelentve
            </div>
            <div class="mt-1 font-mono text-[13px] text-text-primary tabular-nums">
              {{ reportedAt }}
            </div>
          </div>
          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Kategória
            </div>
            <div class="mt-1 text-[13px] text-text-primary">{{ kategoria }}</div>
          </div>
          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Súlyosság
            </div>
            <div class="mt-1 text-[13px] text-text-primary">{{ sulyossag }}</div>
          </div>
          <div v-if="ticket?.key">
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Kulcs
            </div>
            <div class="mt-1 font-mono text-[13px] text-text-primary break-all">
              {{ ticket.key }}
            </div>
          </div>
        </div>

        <div>
          <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
            Leírás
          </div>
          <p
            class="text-[14px] leading-relaxed text-text-primary whitespace-pre-wrap"
            data-testid="ticket-panel-snippet"
          >
            {{ snippet }}
          </p>
        </div>

        <div
          v-if="!hasResolved && !isLoading"
          class="rounded-md border border-border-subtle bg-surface px-3 py-2.5 text-[12px] text-text-muted"
          data-testid="ticket-panel-empty"
        >
          A háttér-lekérés nem talált részleteket ehhez a sorszámhoz.
          Próbáld a "Megnyitás Ask-ban" gombot, vagy a kategória /
          súlyosság mezők kitöltéséhez vidd fel kézzel a CMMS-be.
        </div>
      </template>
    </div>

    <footer
      class="px-5 py-3 border-t border-border-subtle flex items-center justify-end gap-2 shrink-0"
    >
      <Button variant="ghost" size="md" data-testid="ticket-panel-cancel" @click="close">
        Bezárás
      </Button>
      <Button
        variant="primary"
        size="md"
        data-testid="ticket-panel-open-in-ask"
        @click="openInAsk"
      >
        Megnyitás Ask-ban →
      </Button>
    </footer>
  </aside>
</template>
