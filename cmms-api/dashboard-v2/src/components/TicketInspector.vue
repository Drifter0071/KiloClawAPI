<script setup lang="ts">
// src/components/TicketInspector.vue
//
// HIG-flavoured contextual drawer / sheet for a single evidence ticket
// (Phase 7, upgraded 2026-08-17 for the mobile chat fix).
//
// Behaviour:
//   - Desktop (>= md): slides in from the right, 420px wide, full height.
//   - Mobile (< md): rises from the bottom as an iOS-like sheet
//     (max-h 92dvh, rounded top corners, safe-area padding, drag handle).
//   - Teleported to body at z-50 — ALWAYS above the header, composer,
//     bottom nav and chat messages; never part of the message list, so
//     opening it cannot move / inject into / scroll the chat underneath.
//   - Modal semantics: role=dialog + aria-modal, focus trap, initial
//     focus on the close button, focus restored to the trigger, body
//     scroll lock with restore, Escape / backdrop close, reduced-motion
//     aware transitions (200ms in / 160ms out, ease-out, no bounce).
//   - Swipe-down dismissal: conservative — only the mobile drag handle
//     reacts, requiring dy > 70px with |dx| < 40px.
//
// Data flow:
//   - The parent passes a synthetic EvidenceTicket (sorszam only;
//     all other fields blank) on `open: true`.
//   - The fetch query is keyed by sorszam, so clicking a SECOND ticket
//     while the sheet is open simply refetches and re-renders the body
//     — the sheet never closes/reopens, and vue-query drops stale keys.
//   - Closing is via the header X button, the backdrop, the Escape
//     key, or the mobile drag handle. The previous "Megnyitás Ask-ban"
//     footer CTA was removed in Phase 8: operators can tap the sorszam
//     link in the body to open Ask with that ticket prefilled.

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { EvidenceTicket, TicketDetails } from '@/lib/api'
import TicketDetailsBody from '@/components/TicketDetailsBody.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'

const props = defineProps<{
  open: boolean
  ticket: EvidenceTicket | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

function close() {
  emit('update:open', false)
}

// ---------------------------------------------------------------------------
// Modal focus management + body scroll lock
// ---------------------------------------------------------------------------

const sheetRef = ref<HTMLElement | null>(null)
const closeBtnRef = ref<HTMLButtonElement | null>(null)
let lastFocused: Element | null = null
let bodyOverflow = ''

// Unique dialog-title id (aria-labelledby target on the sorszam heading).
const titleId = `ticket-inspector-title-${Math.random().toString(36).slice(2, 8)}`

function onKeydown(evt: KeyboardEvent) {
  if (!props.open) return
  if (evt.key === 'Escape') {
    evt.stopPropagation()
    close()
    return
  }
  if (evt.key === 'Tab') trapFocus(evt)
}

/** Keep Tab / Shift+Tab inside the sheet while it's open. */
function trapFocus(evt: KeyboardEvent) {
  const el = sheetRef.value
  if (!el) return
  const focusables = Array.from(
    el.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
  if (focusables.length === 0) return
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  if (evt.shiftKey && document.activeElement === first) {
    evt.preventDefault()
    last.focus()
  } else if (!evt.shiftKey && document.activeElement === last) {
    evt.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (typeof document === 'undefined') return
    if (isOpen) {
      // Remember what the user clicked so we can restore focus later.
      lastFocused = document.activeElement
      // Lock body scroll WITHOUT clobbering an existing inline value.
      bodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', onKeydown)
      // Initial focus: the close button (never the destructive path).
      await nextTick()
      closeBtnRef.value?.focus()
    } else {
      document.removeEventListener('keydown', onKeydown)
      document.body.style.overflow = bodyOverflow
      if (lastFocused instanceof HTMLElement && lastFocused.isConnected) {
        lastFocused.focus()
      }
      lastFocused = null
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = bodyOverflow
})

// ---------------------------------------------------------------------------
// Swipe-down dismissal (mobile drag handle only — conservative)
// ---------------------------------------------------------------------------

const touchStart = ref<{ y: number; x: number } | null>(null)

function onHandleTouchStart(evt: TouchEvent) {
  const t = evt.touches[0]
  if (t) touchStart.value = { y: t.clientY, x: t.clientX }
}

function onHandleTouchEnd(evt: TouchEvent) {
  const start = touchStart.value
  touchStart.value = null
  if (!start || !props.open) return
  const t = evt.changedTouches[0]
  if (!t) return
  const dy = t.clientY - start.y
  const dx = t.clientX - start.x
  if (dy > 70 && Math.abs(dx) < 40) close()
}

// ---------------------------------------------------------------------------
// Ticket fetch — keyed by sorszam. Switching to a different ticket while
// open changes the query key: the old request is abandoned by vue-query
// and the sheet body shows the loading state until the new one lands.
// ---------------------------------------------------------------------------

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
    <!-- Backdrop fade (also the click-to-dismiss region on both desktop
         and mobile). DIMS + BLURS the underlying chat so the inspector
         reads as an overlay — the background stays recognizably present
         (iOS-sheet style), just clearly inactive. The neutral black
         overlay works in both themes; the chat canvas already swaps
         via semantic tokens. -->
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out"
      leave-active-class="transition-opacity duration-160 ease-in"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 bg-black/45 backdrop-blur-[10px] backdrop-saturate-[.85]"
        aria-hidden="true"
        data-testid="ticket-inspector-backdrop"
        @click="close"
      />
    </Transition>

    <!-- Sheet: mobile bottom sheet / desktop right drawer. Transform
         travel is scoped per breakpoint (y on mobile, x on md+) so the
         desktop drawer never slides diagonally. Under
         prefers-reduced-motion the transform travel is dropped and only
         a short opacity fade remains. -->
    <Transition
      enter-active-class="transition-all duration-200 ease-out motion-reduce:transition-opacity motion-reduce:duration-100"
      leave-active-class="transition-all duration-160 ease-in motion-reduce:transition-opacity motion-reduce:duration-100"
      enter-from-class="translate-y-full md:translate-y-0 md:translate-x-full"
      enter-to-class="translate-y-0 md:translate-y-0 md:translate-x-0"
      leave-from-class="translate-y-0 md:translate-y-0 md:translate-x-0"
      leave-to-class="translate-y-full md:translate-y-0 md:translate-x-full"
    >
      <aside
        v-if="open"
        ref="sheetRef"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        class="fixed z-50 bg-canvas-2 border-border-default shadow-2xl shadow-black/60 flex flex-col overflow-hidden"
        :class="
          // Mobile: bottom sheet, 92dvh max, full width, rounded top
          // corners, safe-area inset for the home indicator.
          'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl border-t ' +
          'pb-[max(0px,env(safe-area-inset-bottom))] ' +
          // Desktop: right-side drawer, full viewport height, 420px wide.
          'md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:max-h-none md:w-[420px] md:rounded-none md:border-l md:border-t-0 md:pb-0'
        "
        data-testid="ticket-inspector"
      >
        <!-- Mobile-only drag handle — also the swipe-down dismiss
             surface (touch-none so the gesture never scrolls the
             sheet). Purely optional: the close button, backdrop tap
             and Escape all close the sheet too. -->
        <div
          class="md:hidden pt-2 pb-1 flex justify-center shrink-0 touch-none select-none"
          aria-hidden="true"
          data-testid="ticket-inspector-drag-handle"
          @touchstart.passive="onHandleTouchStart"
          @touchend="onHandleTouchEnd"
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
              :id="titleId"
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
            ref="closeBtnRef"
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

        <!-- Body — the ONLY scrollable region inside the sheet; the
             chat behind stays locked and untouched. -->
        <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 text-sm">
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
            A háttér-lekérés nem tudta betölteni a ticketet. Frissítsd az
            oldalt, vagy zárd be a panelt és próbáld újra.
          </div>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>
