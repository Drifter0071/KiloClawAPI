<script setup lang="ts">
// src/components/TicketInspector.vue
//
// HIG-flavoured contextual drawer / sheet for a single evidence ticket
// (Phase 7).
//
// Behaviour:
//   - Desktop (>= md): slides in from the right, 420px wide, full height.
//   - Mobile (< md): rises from the bottom as a sheet. The 60px grab
//     handle is a passive affordance — no drag-to-dismiss yet, but the
//     backdrop and Escape key both close it (standard HIG).
//
// Data flow:
//   - The parent passes a synthetic EvidenceTicket (sorszam only;
//     all other fields blank) on `open: true`.
//   - On open, we fire useApi().getTicketBySorszam(sorszam) in the
//     background. The full TicketDetails populates the inspector
//     body — customer, devices, all notes, technician, kategoria,
//     sulyossag, dates. A "Megnyitás Ask-ban" CTA emits openInAsk
//     and either fills the Ask input (if we're already on /ask) or
//     uses setSeedQ for the next navigation (if we're on another
//     page, e.g. the Diff page).

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

const sorszam = computed(() => props.ticket?.sorszam ?? null)

const ticketQuery = useQuery({
  queryKey: computed(() => ['ticket-inspector-lookup', sorszam.value]),
  queryFn: withAutoRetry(async (): Promise<TicketDetails | null> => {
    const s = sorszam.value
    if (!s) return null
    return useApi().getTicketBySorszam(s)
  }),
  enabled: computed(() => !!sorszam.value && props.open),
  staleTime: 30_000,
})

const isLoading = computed(() => ticketQuery.isFetching.value && !ticketQuery.data.value)
const resolvedTicket = computed<TicketDetails | null>(() => ticketQuery.data.value ?? null)
const hasResolved = computed(() => resolvedTicket.value !== null)
const isError = computed(() => ticketQuery.isError.value)

function openInAsk() {
  const s = sorszam.value
  if (!s) return
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
  <Teleport to="body">
    <!-- Backdrop (also acts as the click-to-dismiss region on both
         desktop and mobile). -->
    <div
      v-if="open"
      class="fixed inset-0 z-50 bg-black/60 transition-opacity duration-150"
      aria-hidden="true"
      data-testid="ticket-inspector-backdrop"
      @click="close"
    />

    <!-- Desktop: right-anchored drawer. Mobile: bottom sheet. -->
    <aside
      v-if="open"
      role="dialog"
      aria-modal="true"
      :aria-label="ticket ? `Ticket ${ticket.sorszam}` : 'Ticket részletek'"
      class="fixed z-50 bg-canvas-2 border-border-default shadow-lg shadow-black/50 flex flex-col"
      :class="
        // Desktop: right-side drawer, full height, 420px wide.
        // Mobile: bottom sheet, 85vh, full width, rounded top corners +
        // grab handle. Safe-area inset reserved for notched phones.
        'inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t ' +
          'md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:max-h-none md:w-[420px] md:rounded-none md:border-l md:border-t-0'
      "
      data-testid="ticket-inspector"
    >
      <!-- Mobile-only grab handle (purely decorative, no drag-to-dismiss). -->
      <div
        class="md:hidden pt-2 pb-1 flex justify-center shrink-0"
        aria-hidden="true"
      >
        <span class="w-9 h-1 rounded-full bg-border-strong" />
      </div>

      <!-- Header -->
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
            data-testid="ticket-inspector-sorszam"
            @click="copySorszam"
          >
            {{ ticket?.sorszam ?? '—' }}
          </button>
          <div
            v-if="resolvedTicket && resolvedTicket.customer?.name"
            class="mt-1 text-[12px] text-text-secondary truncate"
            data-testid="ticket-inspector-customer-name"
          >
            {{ resolvedTicket.customer.name }}
          </div>
        </div>
        <button
          type="button"
          class="w-7 h-7 -mr-1 rounded-md border border-border-subtle bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Bezárás"
          data-testid="ticket-inspector-close"
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

      <!-- Body -->
      <div class="flex-1 min-h-0 overflow-y-auto px-5 py-4 text-sm">
        <TicketDetailsBody
          :ticket="resolvedTicket"
          :loading="isLoading"
          :has-resolved="hasResolved"
          density="full"
        />

        <div
          v-if="isError && !hasResolved"
          class="mt-3 rounded-md border border-danger/30 bg-danger/[0.08] px-3 py-2.5 text-[12px] text-rose-200"
          data-testid="ticket-inspector-error"
        >
          A háttér-lekérés nem tudta betölteni a ticketet. Próbáld a
          "Megnyitás Ask-ban" gombot, vagy frissítsd az oldalt.
        </div>
      </div>

      <!-- Footer -->
      <footer
        class="px-5 py-3 border-t border-border-subtle flex items-center justify-end gap-2 shrink-0"
      >
        <Button
          variant="ghost"
          size="md"
          data-testid="ticket-inspector-cancel"
          @click="close"
        >
          Bezárás
        </Button>
        <Button
          variant="primary"
          size="md"
          data-testid="ticket-inspector-open-in-ask"
          @click="openInAsk"
        >
          Megnyitás Ask-ban →
        </Button>
      </footer>
    </aside>
  </Teleport>
</template>
