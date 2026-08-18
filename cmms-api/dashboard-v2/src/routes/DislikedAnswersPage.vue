<script setup lang="ts">
// src/routes/DislikedAnswersPage.vue
//
// Admin-only master/detail page for every disliked Ask answer.
//
//   - Left: scrollable list of rows (newest first). Each row shows
//     the question, customer, date, and reason.
//   - Right (desktop) / bottom sheet (mobile): teleported drawer
//     with the full agent payload — final_text, ticket_cards, tool
//     trace, vote reason. Same HIG pattern as TicketInspector.
//
// The page probes /disliked on mount; admin cookie 401 → /admin/login.
// Pagination is in 50-row pages with a "Több betöltése" button at
// the bottom (manual lazy-load — autoscroll would conflict with the
// drawer's own scroll lock).

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { humanizeError } from '@/lib/errors'
import { useAdminFeedback, type DislikedItem, AdminAuthError } from '@/composables/useAdminFeedback'

const router = useRouter()
const adminFeedback = useAdminFeedback()

const items = ref<DislikedItem[]>([])
const total = ref(0)
const limit = 50
const offset = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const errorText = ref<string | null>(null)
const selectedId = ref<string | null>(null)

const selected = computed<DislikedItem | null>(() => {
  if (!selectedId.value) return null
  return items.value.find((i) => i.answer_id === selectedId.value) ?? null
})

async function fetchFirstPage(): Promise<void> {
  loading.value = true
  errorText.value = null
  try {
    const r = await adminFeedback.loadDisliked(limit, 0)
    items.value = r.items
    total.value = r.total
    offset.value = r.items.length
  } catch (e) {
    if (e instanceof AdminAuthError) {
      await router.push('/admin/login')
      return
    }
    errorText.value = humanizeError(e).description
  } finally {
    loading.value = false
  }
}

async function loadMore(): Promise<void> {
  if (loadingMore.value || items.value.length >= total.value) return
  loadingMore.value = true
  errorText.value = null
  try {
    const r = await adminFeedback.loadDisliked(limit, offset.value)
    items.value = items.value.concat(r.items)
    offset.value = items.value.length
  } catch (e) {
    if (e instanceof AdminAuthError) {
      await router.push('/admin/login')
      return
    }
    errorText.value = humanizeError(e).description
  } finally {
    loadingMore.value = false
  }
}

function open(item: DislikedItem): void {
  selectedId.value = item.answer_id
}
function closeDrawer(): void {
  selectedId.value = null
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return iso
  }
}

function reasonLabel(reason: string | null): string {
  if (!reason) return '—'
  if (reason.startsWith('other:')) return `Egyéb: ${reason.slice('other:'.length, 40)}${reason.length > 40 + 'other:'.length ? '…' : ''}`
  switch (reason) {
    case 'wrong customer/device': return 'Hibás ügyfél / eszköz'
    case 'wrong data (number/date/count)': return 'Hibás adat'
    case 'missed relevant ticket(s)': return 'Kihagyott ticket(ek)'
    case 'made something up': return 'Kitalált információ'
    case 'wording/format only': return 'Csak megfogalmazás'
    default: return reason
  }
}

// Body scroll lock for the drawer — same pattern as TicketInspector.
let savedOverflow = ''
function lockBodyScroll(): void {
  if (typeof document === 'undefined') return
  savedOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
}
function unlockBodyScroll(): void {
  if (typeof document === 'undefined') return
  document.body.style.overflow = savedOverflow
}

function goBack(): void {
  router.push('/admin')
}

onMounted(() => {
  void fetchFirstPage()
})

onBeforeUnmount(() => {
  if (selectedId.value) unlockBodyScroll()
})

// Reactive effect on selectedId to lock/unlock scroll.
watch(selectedId, (id) => {
  if (id) lockBodyScroll()
  else unlockBodyScroll()
})
</script>

<template>
  <div
    class="nct-theme-transition min-h-[100dvh] w-full
           bg-[var(--color-canvas)] text-[var(--nct-form-text)] font-sans antialiased
           px-4 sm:px-6 py-6 sm:py-8"
    data-testid="disliked-answers-page"
  >
    <div class="max-w-5xl mx-auto space-y-5">
      <!-- Header -->
      <header class="flex items-start justify-between gap-4">
        <div>
          <button
            type="button"
            class="text-[12px] font-mono text-[var(--nct-form-text-muted)]
                   hover:text-[var(--nct-form-text)]
                   focus:outline-none focus-visible:underline"
            data-testid="disliked-answers-back"
            @click="goBack"
          >
            ← Vissza az admin panelre
          </button>
          <h1
            class="text-[1.4rem] sm:text-[1.6rem] font-semibold tracking-tight m-0 mt-2"
            data-testid="disliked-answers-title"
          >
            Disliked válaszok
          </h1>
          <p class="mt-1 text-[13px] text-[var(--nct-form-text-muted)] m-0">
            <span data-testid="disliked-answers-total">{{ total }}</span> db 👎 szavazat,
            időrendben. Kattints egy sorra a teljes ügynök-válasz megtekintéséhez.
          </p>
        </div>
      </header>

      <!-- Error -->
      <div
        v-if="errorText"
        class="rounded-xl border border-danger/30 bg-danger/10 p-4 text-danger text-[13px]"
        data-testid="disliked-answers-error"
        role="alert"
      >
        {{ errorText }}
      </div>

      <!-- Loading -->
      <div
        v-if="loading && items.length === 0"
        class="rounded-xl border border-[var(--nct-form-border)]
               bg-[var(--nct-form-bg)] p-8 text-center"
        data-testid="disliked-answers-loading"
      >
        <div class="text-[14px] text-[var(--nct-form-text-muted)]">Betöltés…</div>
      </div>

      <!-- List -->
      <ul
        v-else-if="items.length > 0"
        class="space-y-2"
        data-testid="disliked-answers-list"
      >
        <li
          v-for="item in items"
          :key="item.answer_id"
        >
          <button
            type="button"
            class="w-full text-left
                   rounded-xl border bg-[var(--nct-form-bg)]
                   px-4 py-3
                   transition-colors duration-150
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40"
            :class="selectedId === item.answer_id
                     ? 'border-nct-soft/60'
                     : 'border-[var(--nct-form-border)] hover:border-nct-soft/30'"
            :data-testid="`disliked-answers-row-${item.answer_id}`"
            @click="open(item)"
          >
            <div class="flex items-baseline justify-between gap-3 min-w-0">
              <div class="min-w-0">
                <div class="text-[13.5px] font-medium text-[var(--nct-form-text)] truncate">
                  {{ item.q }}
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--nct-form-text-muted)]">
                  <span v-if="item.resolved_customer" class="font-medium">{{ item.resolved_customer }}</span>
                  <span v-if="item.model" class="font-mono">· {{ item.model }}</span>
                  <span class="font-mono">· {{ item.iterations }} lépés</span>
                </div>
              </div>
              <div class="shrink-0 text-right">
                <div class="text-[10.5px] font-mono text-[var(--nct-form-text-muted)] tabular-nums">
                  {{ fmtDate(item.vote.created_at) }}
                </div>
                <div class="text-[11px] text-[var(--nct-form-text-muted)] mt-0.5">
                  {{ reasonLabel(item.vote.reason) }}
                </div>
              </div>
            </div>
          </button>
        </li>
      </ul>

      <!-- Empty -->
      <div
        v-else
        class="rounded-xl border border-[var(--nct-form-border)]
               bg-[var(--nct-form-bg)] p-8 text-center"
        data-testid="disliked-answers-empty"
      >
        <div class="text-[14px] text-[var(--nct-form-text-muted)]">
          Még nincs dislike szavazat.
        </div>
      </div>

      <!-- Load more -->
      <div
        v-if="items.length < total"
        class="text-center pt-2"
      >
        <button
          type="button"
          :disabled="loadingMore"
          class="px-4 py-2 rounded-md text-[13px] font-medium
                 border border-[var(--nct-form-border)] bg-[var(--nct-form-bg)]
                 hover:bg-[var(--nct-surface)]
                 disabled:opacity-40 disabled:cursor-not-allowed
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40"
          data-testid="disliked-answers-load-more"
          @click="loadMore"
        >
          {{ loadingMore ? 'Betöltés…' : `Több betöltése (${items.length}/${total})` }}
        </button>
      </div>
    </div>

    <!-- Detail drawer (teleported, mobile = bottom sheet / desktop = right drawer) -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-opacity duration-200 ease-out"
        leave-active-class="transition-opacity duration-160 ease-in"
      >
        <div
          v-if="selected"
          class="fixed inset-0 z-50 bg-black/45 backdrop-blur-[10px] backdrop-saturate-[.85]"
          data-testid="disliked-answers-backdrop"
          @click="closeDrawer"
        />
      </Transition>
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-160 ease-in"
      >
        <aside
          v-if="selected"
          class="fixed z-50 bg-[var(--nct-form-bg)] border-[var(--nct-form-border)]
                 shadow-2xl overflow-y-auto
                 inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl border-t
                 pb-[max(0px,env(safe-area-inset-bottom))]
                 md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:max-h-none
                 md:w-[480px] md:rounded-none md:border-l md:border-t-0 md:pb-0"
          role="dialog"
          aria-modal="true"
          aria-labelledby="disliked-drawer-title"
          data-testid="disliked-answers-drawer"
          @click.stop
        >
          <div class="px-5 py-4 border-b border-[var(--nct-form-border)] flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-[10.5px] font-mono uppercase tracking-wider text-[var(--nct-form-text-muted)]">
                Disliked answer
              </div>
              <h2
                id="disliked-drawer-title"
                class="mt-1 text-[15px] font-semibold text-[var(--nct-form-text)] m-0 break-words"
              >
                {{ selected.q }}
              </h2>
              <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--nct-form-text-muted)]">
                <span v-if="selected.resolved_customer" class="font-medium">{{ selected.resolved_customer }}</span>
                <span class="font-mono">· {{ selected.model }}</span>
                <span class="font-mono">· {{ selected.iterations }} lépés</span>
                <span class="font-mono">· {{ selected.language.toUpperCase() }}</span>
              </div>
            </div>
            <button
              type="button"
              class="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md
                     text-[var(--nct-form-text-muted)] hover:bg-[var(--nct-surface)]
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40"
              data-testid="disliked-answers-drawer-close"
              @click="closeDrawer"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="6" y1="18" x2="18" y2="6" />
              </svg>
            </button>
          </div>

          <div class="px-5 py-4 space-y-4">
            <!-- Reason (the fine-tune-actionable bucket) -->
            <div data-testid="disliked-answers-drawer-reason">
              <div class="text-[10.5px] font-mono uppercase tracking-wider text-[var(--nct-form-text-muted)]">
                Indok
              </div>
              <div class="mt-1 text-[13px] text-[var(--nct-form-text)] break-words">
                {{ reasonLabel(selected.vote.reason) }}
              </div>
            </div>

            <!-- Final text -->
            <div data-testid="disliked-answers-drawer-final">
              <div class="text-[10.5px] font-mono uppercase tracking-wider text-[var(--nct-form-text-muted)]">
                Végső válasz
              </div>
              <div class="mt-1 text-[13.5px] text-[var(--nct-form-text)] leading-relaxed whitespace-pre-wrap break-words">
                {{ selected.final_text }}
              </div>
            </div>

            <!-- Ticket cards -->
            <div v-if="Array.isArray(selected.ticket_cards) && (selected.ticket_cards as unknown[]).length > 0"
                 data-testid="disliked-answers-drawer-ticket-cards">
              <div class="text-[10.5px] font-mono uppercase tracking-wider text-[var(--nct-form-text-muted)]">
                Ticket kártyák
              </div>
              <ul class="mt-1.5 space-y-1.5">
                <li
                  v-for="(card, i) in (selected.ticket_cards as Array<Record<string, unknown>>)"
                  :key="`${String(card.sorszam ?? i)}`"
                  class="rounded-md border border-[var(--nct-form-border)]
                         bg-[var(--nct-surface)] px-2.5 py-2"
                >
                  <div class="font-mono text-[12px] text-nct-soft">{{ String(card.sorszam ?? '?') }}</div>
                  <div v-if="card.customer_name" class="text-[11.5px] text-[var(--nct-form-text)] mt-0.5">
                    {{ String(card.customer_name) }}
                  </div>
                  <div v-if="card.snippet" class="text-[11.5px] text-[var(--nct-form-text-muted)] mt-0.5 line-clamp-3">
                    {{ String(card.snippet) }}
                  </div>
                </li>
              </ul>
            </div>

            <!-- Tool trace -->
            <div v-if="Array.isArray(selected.tool_trace) && (selected.tool_trace as unknown[]).length > 0"
                 data-testid="disliked-answers-drawer-tool-trace">
              <div class="text-[10.5px] font-mono uppercase tracking-wider text-[var(--nct-form-text-muted)]">
                Tool trace ({{ (selected.tool_trace as unknown[]).length }})
              </div>
              <ul class="mt-1.5 space-y-1">
                <li
                  v-for="(t, i) in (selected.tool_trace as Array<Record<string, unknown>>)"
                  :key="`${String(t.name ?? i)}-${i}`"
                  class="font-mono text-[11px] flex items-center gap-2"
                >
                  <span
                    class="w-1.5 h-1.5 rounded-full shrink-0"
                    :class="t.ok === true ? 'bg-emerald-400' : 'bg-rose-400'"
                  />
                  <span>{{ String(t.name ?? '?') }}</span>
                  <span v-if="t.ok !== true" class="text-rose-500">[{{ String(t.note ?? 'fail') }}]</span>
                </li>
              </ul>
            </div>

            <!-- Footer meta -->
            <div class="pt-3 border-t border-[var(--nct-form-border)] text-[10.5px] font-mono text-[var(--nct-form-text-muted)] space-y-0.5">
              <div>answer_id: <span class="select-all">{{ selected.answer_id }}</span></div>
              <div>vote created_at: {{ fmtDate(selected.vote.created_at) }}</div>
              <div>answer created_at: {{ fmtDate(selected.created_at) }}</div>
            </div>
          </div>
        </aside>
      </Transition>
    </Teleport>
  </div>
</template>
