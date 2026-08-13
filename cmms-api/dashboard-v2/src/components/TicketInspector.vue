<script setup lang="ts">
// src/components/TicketInspector.vue
//
// HIG-flavoured contextual drawer / sheet for a single evidence ticket
// (Phase 7).
//
// Behaviour:
//   - Desktop (>= md): slides in from the right, 420px wide, full height.
//     Same data-testids / a11y attrs as the existing Drawer so callers
//     can swap between the two.
//   - Mobile (< md): rises from the bottom as a sheet. The 60px grab
//     handle is a passive affordance — no drag-to-dismiss yet, but the
//     backdrop and Escape key both close it (standard HIG).
//
// The ticket payload is the EvidenceTicket shape (lib/api.ts). We don't
// have a dedicated /ticket/:sorszam endpoint today, so the inspector
// renders the structured fields we already have + a "Megnyitás Ask-ban"
// CTA that seeds the Ask page's input with the sorszam.

import { computed, onBeforeUnmount, watch } from 'vue'
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `2026-08-12T10:30:00Z` -> `2026.08.12. 10:30` (operator-local, Hungary). */
const reportedAt = computed(() => {
  const t = props.ticket?.reported_at_iso
  if (!t) return '—'
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return t
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}. ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
})

const kategoria = computed(() => {
  const t = props.ticket
  if (!t) return '—'
  return t.kategoria ?? t.kategoria_inferred ?? '—'
})

const sulyossag = computed(() => {
  const t = props.ticket
  if (!t) return '—'
  return t.sulyossag_inferred ?? '—'
})

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
      <div class="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4 text-sm">
        <div class="grid grid-cols-2 gap-3" data-testid="ticket-inspector-meta">
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
            data-testid="ticket-inspector-snippet"
          >
            {{ ticket?.snippet ?? '—' }}
          </p>
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
