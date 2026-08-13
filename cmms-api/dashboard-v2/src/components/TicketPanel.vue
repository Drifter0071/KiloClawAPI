<script setup lang="ts">
// src/components/TicketPanel.vue
//
// In-place right-column ticket panel (HIG inspector variant).
//
// Used by the Ask page when the operator taps a sorszam in a message
// bubble. Lives inside the page layout (not teleported) so the
// conversation column reflows to the left and the panel occupies the
// right column at full viewport height.
//
// On mobile (< md) the panel becomes a bottom sheet that slides up
// from below the conversation (same pattern as TicketInspector, just
// without the body-teleport).
//
// The ticket payload is the same EvidenceTicket shape that
// TicketInspector accepts. The "Megnyitás Ask-ban" CTA closes the
// panel and seeds the Ask page input via setSeedQ (handled by the
// parent Ask page via the `openInAsk` emit).

import { onBeforeUnmount, watch } from 'vue'
import type { EvidenceTicket } from '@/lib/api'
import Button from '@/components/Button.vue'
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

function fmtTimestamp(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}. ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const reportedAt = fmtTimestamp(props.ticket?.reported_at_iso)
const kategoria = props.ticket?.kategoria ?? props.ticket?.kategoria_inferred ?? '—'
const sulyossag = props.ticket?.sulyossag_inferred ?? '—'

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
          {{ ticket?.snippet ?? '—' }}
        </p>
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
