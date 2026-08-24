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
//   - On open, we fire useApi().getTicketBySorszam(sorszam) in the
//     background. The full TicketDetails (customer, devices, all
//     notes, technician, dates) populates the panel without a
//     dedicated /v1/tickets/:sorszam endpoint needing a separate
//     call from the page.
//   - M-prefix sorszams (machines) are NOT opened in this panel —
//     the parent (AskPage) routes them to /ask via setSeedQ instead.
//
// Emits:
//   update:open(value)  — user closed the panel (X, Escape, or "Bezárás")
//   openInAsk(sorszam)  — user clicked "Megnyitás Ask-ban" CTA

import { computed, onBeforeUnmount, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useRoute } from 'vue-router'
import type { EvidenceTicket, TicketDetails } from '@/lib/api'
import Button from '@/components/Button.vue'
import TicketDetailsBody from '@/components/TicketDetailsBody.vue'
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
// Background fetch: ask the cmms-api for the full ticket.
//
// Dedicated GET /v1/tickets/by-sorszam/:sorszam endpoint (proxied via
// /dashboard/api/ticket?sorszam=…). Returns the entire JobCard: customer,
// devices, all notes (reported / work / free), technician, kategoria,
// sulyossag, dates. The query is keyed on sorszam so a re-open with a
// different sorszam refetches automatically.
// ---------------------------------------------------------------------------

const sorszam = computed(() => props.ticket?.sorszam ?? null)

const ticketQuery = useQuery({
  queryKey: computed(() => ['ticket-panel-lookup', sorszam.value]),
  queryFn: withAutoRetry(async (): Promise<TicketDetails | null> => {
    const s = sorszam.value
    if (!s) return null
    return useApi().getTicketBySorszam(s)
  }),
  enabled: computed(() => !!sorszam.value && props.open),
  // Tickets don't change in the runtime sense — a 30s stale window
  // covers any "I just edited a note in CMMS" race without thrashing
  // on every keystroke. Force a refetch when the user re-opens the
  // panel (the queryKey changes per sorszam so re-open = new query).
  // No retry: 404 / network errors should surface to the user
  // immediately, not get masked by a one-retry delay.
  staleTime: 30_000,
})

const isLoading = computed(() => ticketQuery.isFetching.value && !ticketQuery.data.value)
const resolvedTicket = computed<TicketDetails | null>(() => ticketQuery.data.value ?? null)
const hasResolved = computed(() => resolvedTicket.value !== null)
const isError = computed(() => ticketQuery.isError.value)

function openInAsk() {
  const s = sorszam.value
  if (!s) return
  // Two cases:
  //   1. We're on /ask already — emit openInAsk, parent fills the
  //      input field directly (no router roundtrip, no remount).
  //   2. We're elsewhere — setSeedQ drops the question into the
  //      history.state of the next /ask navigation; AskPage's
  //      onMounted consumeSeedQ() picks it up and submits.
  const onAsk = useRoute().path.startsWith('/ask')
  if (onAsk) {
    emit('openInAsk', s)
  } else {
    setSeedQ(`ticket ${s}`)
    emit('openInAsk', s)
  }
  close()
}

function copySorszam() {
  const s = sorszam.value
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
      md:sticky md:top-0
      md:max-h-[calc(100dvh-52px)]
      md:self-start
      max-h-[85dvh]
      overflow-hidden
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
          v-if="resolvedTicket && resolvedTicket.customer?.name"
          class="mt-1 text-[12px] text-text-secondary truncate"
          data-testid="ticket-panel-customer-name"
        >
          {{ resolvedTicket.customer.name }}
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

    <div
      class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 text-sm"
      data-testid="ticket-panel-body"
    >
      <TicketDetailsBody
        :ticket="resolvedTicket"
        :loading="isLoading"
        :has-resolved="hasResolved"
        density="full"
      />

      <div
        v-if="isError && !hasResolved"
        class="mt-3 rounded-md border border-danger/30 bg-danger/[0.08] px-3 py-2.5 text-[12px] text-rose-200"
        data-testid="ticket-panel-error"
      >
        A háttér-lekérés nem tudta betölteni a ticketet. Próbáld a
        "Megnyitás Ask-ban" gombot, vagy frissítsd az oldalt.
      </div>
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
