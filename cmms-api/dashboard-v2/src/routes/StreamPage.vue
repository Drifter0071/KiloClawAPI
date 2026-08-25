<script setup lang="ts">
// src/routes/StreamPage.vue
//
// v2 Live Stream — AI Operations Control Room.
//
// Layout (responsive, three regions):
//   1. Operational header: title, live status, event count, pause,
//      clear-history.
//   2. Filter + search toolbar + inline AskBar.
//   3. Main feed: dense scannable event list with day-boundary labels,
//      embedded approval cards. Selecting an event opens the
//      right-side EventInspector drawer (full-screen sheet on mobile).
//
// Visual / product notes:
//   - Brand color (#452b68 / nct.500) reserved for the active state,
//     focus rings, and the live dot; semantic colors (success /
//     warning / danger) for approval outcomes; muted text for metadata.
//   - The page is scannable by default: time · type pill · status pill
//     · summary. Detail opens in the inspector.
//   - Pause freezes the visible buffer (per spec) and counts dropped
//     events in a small badge.
//   - Search debounces against an in-memory filter (the page does NOT
//     push queries to the backend; the stream is an in-memory list).
//   - Historical backfill: on mount we hit /dashboard/api/audit and
//     merge its entries as stream events, deduped by t+type.
//
// All existing data-testids are preserved so tests/stream.spec.ts keeps
// passing. New testids introduced: event-inspector, inspector-close,
// stream-status, stream-search, stream-filter-reset, stream-clear.

import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import AskBar from '@/components/AskBar.vue'
import AnswerBody from '@/components/AnswerBody.vue'
import Button from '@/components/Button.vue'
import EmptyState from '@/components/EmptyState.vue'
import EventInspector from '@/components/EventInspector.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { useStreamEvents } from '@/composables/useStreamEvents'
import { useStreamStore } from '@/stores/stream'
import { setSeedQ } from '@/composables/useSeedQ'
import { connectionState } from '@/composables/useEventSource'
import { humanizeError } from '@/lib/errors'
import { renderAnswer, type AnswerView } from '@/lib/renderAnswer'
import type {
  AnswerRequest,
  AnswerResponse,
  AuditEntry,
  StreamApprovalEvent,
  StreamEvent,
} from '@/lib/api'

const { events, pause, togglePause, clear } = useStreamEvents()

type FeedFilter = 'all' | 'questions' | 'approvals'

const FILTER_OPTIONS: { value: FeedFilter; label: string }[] = [
  { value: 'all', label: 'Mind' },
  { value: 'questions', label: 'Kérdések' },
  { value: 'approvals', label: 'Jóváhagyások' },
]

const filter = ref<FeedFilter>('all')
const search = ref('')
const searchDebounced = ref('')
let searchTimer: number | null = null

watch(search, (v) => {
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchDebounced.value = v.trim().toLowerCase()
  }, 120)
})

// ---------------------------------------------------------------------------
// Selected event (opens the EventInspector drawer)
// ---------------------------------------------------------------------------

const selected = ref<StreamEvent | null>(null)
const inspectorOpen = ref(false)

function selectEvent(ev: StreamEvent) {
  selected.value = ev
  inspectorOpen.value = true
}

function onApprovalResolved(_payload: { id: string; approved: boolean }) {
  // The local store is updated by the resolver; the inspector stays open
  // so the operator sees the new state. No need to refetch.
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function matchesText(ev: StreamEvent, q: string): boolean {
  if (!q) return true
  if (ev.type === 'question' && typeof ev.q === 'string' && ev.q.toLowerCase().includes(q)) {
    return true
  }
  if (ev.type === 'answer' && typeof ev.summary === 'string' && ev.summary.toLowerCase().includes(q)) {
    return true
  }
  if (ev.type === 'approval') {
    const a = ev as StreamApprovalEvent
    const hay = `${a.id} ${a.action} ${a.summary}`.toLowerCase()
    if (hay.includes(q)) return true
  }
  if ((ev as any).tool && String((ev as any).tool).toLowerCase().includes(q)) return true
  return false
}

const visibleEvents = computed<StreamEvent[]>(() => {
  const q = searchDebounced.value
  return events.value.filter((ev) => {
    if (ev.type === 'hello') return false
    if (filter.value === 'questions' && ev.type !== 'question' && ev.type !== 'answer') {
      return false
    }
    if (filter.value === 'approvals' && ev.type !== 'approval') {
      return false
    }
    if (q && !matchesText(ev, q)) return false
    return true
  })
})

const eventCount = computed(() => visibleEvents.value.length)
const totalCount = computed(() => events.value.filter((e) => e.type !== 'hello').length)
const approvalCount = computed(
  () => events.value.filter((e) => e.type === 'approval' && !String((e as any).summary || '').match(/^(APPROVED|REJECTED):/)).length,
)

const hasActiveFilter = computed(() => filter.value !== 'all' || searchDebounced.value.length > 0)

function resetFilters() {
  filter.value = 'all'
  search.value = ''
  searchDebounced.value = ''
}

const connected = computed(() => connectionState.value === 'connected')

// ---------------------------------------------------------------------------
// Event metadata helpers
// ---------------------------------------------------------------------------

type EventVisual = {
  label: string
  body: string
  icon: 'q' | 'a' | 'shield' | 'info'
  iconClass: string
  barClass: string
  statusLabel: string
  statusClass: string
}

function eventVisual(ev: StreamEvent): EventVisual {
  switch (ev.type) {
    case 'question':
      return {
        label: 'KÉRDÉS',
        body: ev.q,
        icon: 'q',
        iconClass: 'text-nct-soft bg-nct-500/15 border-nct-500/30',
        barClass: 'border-l-nct-soft',
        statusLabel: 'Bejövő',
        statusClass: 'bg-nct-500/15 text-nct-soft',
      }
    case 'answer':
      return {
        label: 'VÁLASZ',
        body: ev.summary,
        icon: 'a',
        iconClass: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30',
        barClass: 'border-l-emerald-500/60',
        statusLabel: 'Kész',
        statusClass: 'bg-emerald-500/15 text-emerald-300',
      }
    case 'approval': {
      const a = ev as StreamApprovalEvent
      const isApproved = typeof a.summary === 'string' && a.summary.startsWith('APPROVED:')
      const isRejected = typeof a.summary === 'string' && a.summary.startsWith('REJECTED:')
      const resolved = isApproved || isRejected
      return {
        label: 'JÓVÁHAGYÁS',
        body: a.summary,
        icon: 'shield',
        iconClass: resolved
          ? 'text-text-muted bg-surface-2 border-border-subtle'
          : 'text-amber-300 bg-amber-500/15 border-amber-500/40',
        barClass: resolved
          ? 'border-l-border-subtle'
          : 'border-l-amber-500/70',
        statusLabel: isApproved ? 'Jóváhagyva' : isRejected ? 'Elutasítva' : 'Jóváhagyásra vár',
        statusClass: isApproved
          ? 'bg-emerald-500/15 text-emerald-300'
          : isRejected
            ? 'bg-rose-500/15 text-rose-300'
            : 'bg-amber-500/20 text-amber-300',
      }
    }
    default: {
      const fallbackType = (ev as StreamEvent).type || 'event'
      return {
        label: String(fallbackType).toUpperCase(),
        body: '',
        icon: 'info',
        iconClass: 'text-text-secondary bg-surface-2 border-border-subtle',
        barClass: 'border-l-border-subtle',
        statusLabel: '—',
        statusClass: 'bg-surface-2 text-text-secondary',
      }
    }
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fmtDayLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

// Group visible events by day boundary so the operator can see where
// one day ends and the next begins without scanning timestamps.
interface EventGroup {
  day: string
  events: StreamEvent[]
}

const groupedEvents = computed<EventGroup[]>(() => {
  const groups: EventGroup[] = []
  let lastDay = ''
  for (const ev of visibleEvents.value) {
    const day = fmtDayLabel(ev.t)
    if (day !== lastDay) {
      groups.push({ day, events: [ev] })
      lastDay = day
    } else {
      groups[groups.length - 1]!.events.push(ev)
    }
  }
  return groups
})

// ---------------------------------------------------------------------------
// Inline ask → answer
// ---------------------------------------------------------------------------

const q = ref('')
const currentQ = ref('')
const run = ref(0)
const answerOpen = ref(false)
const inlineError = ref<string | null>(null)
const pendingFilters = ref<Partial<AnswerRequest>>({})

function detectLang(text: string): 'hu' | 'en' {
  return /[^\x00-\x7F]/.test(text) ? 'hu' : 'en'
}

const answerQuery = useQuery({
  queryKey: ['stream-answer', currentQ, run],
  queryFn: withAutoRetry(() =>
    useApi().answer({
      q: currentQ.value,
      language: detectLang(currentQ.value),
      ...pendingFilters.value,
    }),
  ),
  enabled: computed(() => run.value > 0),
})

const answerData = computed<AnswerResponse | null>(() => answerQuery.data.value ?? null)
const answerBusy = computed(() => run.value > 0 && answerQuery.isFetching.value)
const answerError = computed(() =>
  answerQuery.isError.value ? humanizeError(answerQuery.error.value) : null,
)

function submitQuestion(text: string) {
  const trimmed = text.trim()
  if (trimmed.length === 0 || answerBusy.value) return
  currentQ.value = trimmed
  pendingFilters.value = {}
  inlineError.value = null
  answerOpen.value = true
  run.value += 1
}

function showInAsk() {
  if (currentQ.value.length > 0) setSeedQ(currentQ.value)
}

function onStreamSorszamClick(payload: { prefix: 'B' | 'M'; sorszam: string }) {
  const seed = payload.prefix === 'B' ? `ticket ${payload.sorszam}` : payload.sorszam
  setSeedQ(seed)
}

function runConfirmed(view: AnswerView) {
  const filters: Partial<AnswerRequest> = {}
  const f = view.confirmFilters
  if (f) {
    for (const key of [
      'customer',
      'device',
      'kategoria',
      'kategoria_inferred',
      'sulyossag_inferred',
      'period',
      'status',
    ] as const) {
      const v = f[key]
      if (typeof v === 'string' && v.length > 0) filters[key] = v
    }
    if (typeof f.limit === 'number' && f.limit > 0) filters.limit = f.limit
  }
  currentQ.value = view.q
  pendingFilters.value = filters
  inlineError.value = null
  answerOpen.value = true
  run.value += 1
}

function retryAnswer() {
  inlineError.value = null
  run.value += 1
}

function collapseAnswer() {
  answerOpen.value = !answerOpen.value
}

// ---------------------------------------------------------------------------
// Audit-log backfill (history merged as stream events on mount)
// ---------------------------------------------------------------------------

function auditToStreamEvent(entry: AuditEntry): StreamEvent | null {
  if (entry.action === 'question') {
    const detail = entry.detail || ''
    return { type: 'question', t: entry.t, tool: entry.tool || 'answer', q: detail }
  }
  if (entry.action === 'answer') {
    return { type: 'answer', t: entry.t, tool: entry.tool || 'answer', summary: entry.detail || '' }
  }
  if (entry.action === 'approval') {
    const detail = entry.detail || ''
    const m = detail.match(/^([a-zA-Z0-9_-]+)\s+(APPROVED|REJECTED):\s*(.*)$/)
    if (m) {
      return {
        type: 'approval',
        t: entry.t,
        id: m[1]!,
        action: entry.tool || 'approval',
        summary: `${m[2]}: ${m[3]}`,
      }
    }
    return {
      type: 'approval',
      t: entry.t,
      id: 'unknown',
      action: entry.tool || 'approval',
      summary: detail,
    }
  }
  return null
}

const seenAuditKeys = new Set<string>()

function mergeAuditEntries(entries: AuditEntry[]) {
  const store = useStreamStore()
  const existing = new Set(events.value.map((e) => `${e.t}|${e.type}`))
  for (const entry of entries) {
    const ev = auditToStreamEvent(entry)
    if (!ev) continue
    const k = `${ev.t}|${ev.type}`
    if (seenAuditKeys.has(k) || existing.has(k)) continue
    seenAuditKeys.add(k)
    store.pushEvent(ev)
  }
}

// ---------------------------------------------------------------------------
// SSE subscription + audit fetch
// ---------------------------------------------------------------------------

let unsubscribeStream: (() => void) | null = null

const auditQuery = useQuery({
  queryKey: ['stream-audit', 50],
  queryFn: withAutoRetry(() => useApi().audit(50)),
  staleTime: 60_000,
  refetchOnWindowFocus: false,
})

watch(auditQuery.data, (data) => {
  if (data?.entries) mergeAuditEntries(data.entries)
})

onMounted(() => {
  const store = useStreamStore()
  unsubscribeStream = store.subscribe()
  // Trigger the audit fetch in case useQuery's initial run was skipped
  if (!auditQuery.data.value) auditQuery.refetch()
})

onScopeDispose(() => {
  unsubscribeStream?.()
  unsubscribeStream = null
})

watch(
  () => answerQuery.data.value,
  (data) => {
    if (data) answerOpen.value = true
  },
)
</script>

<template>
  <div class="h-full flex flex-col bg-canvas text-text-primary" data-testid="stream-page">
    <!-- =================================================================
         OPERATIONAL HEADER
         Title · subtitle · live status pill · event counter · pause/clear
         ================================================================= -->
    <header
      class="shrink-0 border-b border-border-subtle bg-canvas-2/70 backdrop-blur-md"
    >
      <div class="px-4 md:px-6 h-13 flex items-center gap-3 md:gap-4">
        <!-- Title block -->
        <div class="min-w-0 flex-1">
          <h1 class="text-[14px] md:text-[15px] font-semibold tracking-tight text-text-primary leading-none flex items-center gap-2">
            <span
              class="inline-block w-1.5 h-4 rounded-sm bg-nct-soft"
              aria-hidden="true"
            />
            Élő stream
          </h1>
          <p class="text-[11px] md:text-[12px] text-text-muted mt-1 truncate">
            Az API-n áthaladó események és AI-műveletek
          </p>
        </div>

        <!-- Live status pill -->
        <span
          class="hidden sm:inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border-subtle bg-surface font-mono text-[11px] text-text-secondary tabular-nums"
          :class="{
            'border-success/40 text-success': connected,
            'border-warning/40 text-warning': connectionState === 'reconnecting',
            'border-danger/40 text-danger': !connected && connectionState !== 'reconnecting',
          }"
          data-testid="stream-status"
        >
          <span
            class="inline-block w-1.5 h-1.5 rounded-full"
            :class="{
              'bg-success animate-pulse': connected,
              'bg-warning animate-pulse': connectionState === 'reconnecting',
              'bg-danger': !connected && connectionState !== 'reconnecting',
            }"
            aria-hidden="true"
          />
          <span v-if="connected">Élő</span>
          <span v-else-if="connectionState === 'reconnecting'">Újracsatlakozás…</span>
          <span v-else>Kapcsolat nélkül</span>
        </span>

        <!-- Event counter -->
        <span
          class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-surface border border-border-subtle font-mono text-[11px] text-text-secondary tabular-nums"
          data-testid="live-counter"
        >
          <span v-if="pause" class="text-warning">Szünetelve</span>
          <span v-else-if="!connected" class="text-danger">Szünetelve</span>
          <template v-else>Élő</template>
          · {{ pause ? totalCount : eventCount }} esemény
          <span
            v-if="approvalCount > 0"
            class="ml-1 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-amber-500/20 text-amber-300 text-[10px] font-semibold"
            :title="`${approvalCount} függőben lévő jóváhagyás`"
          >
            {{ approvalCount }}
          </span>
        </span>

        <!-- Pause / resume -->
        <Button
          variant="secondary"
          size="sm"
          :aria-pressed="pause"
          data-testid="stream-pause"
          @click="togglePause"
        >
          <span class="inline-flex items-center gap-1.5">
            <svg
              v-if="!pause"
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
            <svg
              v-else
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M7 5l12 7-12 7V5z" />
            </svg>
            {{ pause ? 'Folytatás' : 'Szünet' }}
          </span>
        </Button>

        <!-- Clear history (visible only when something to clear) -->
        <button
          v-if="totalCount > 0"
          type="button"
          class="hidden md:inline-flex h-7 px-2 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 text-[11px] font-medium transition-colors"
          data-testid="stream-clear"
          @click="clear"
        >
          Törlés
        </button>
      </div>
    </header>

    <!-- =================================================================
         DISCONNECTED BANNER
         ================================================================= -->
    <div
      v-if="!connected"
      class="px-4 md:px-6 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-300 shrink-0"
      data-testid="stream-banner"
    >
      <span class="inline-flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        A stream megszakadt
        <template v-if="events[0]">
          — utolsó esemény {{ fmtTime(events[0].t) }}.
        </template>
        <template v-else>.</template>
        Újrapróbálkozás a háttérben.
      </span>
    </div>

    <!-- =================================================================
         FILTER + SEARCH + ASKBAR TOOLBAR
         ================================================================= -->
    <div class="shrink-0 border-b border-border-subtle bg-canvas-2/40">
      <!-- Segmented filter + search row -->
      <div class="px-4 md:px-6 py-2.5 flex flex-wrap items-center gap-2 md:gap-3">
        <SegmentedControl
          v-model="filter"
          :options="FILTER_OPTIONS"
          aria-label="Stream szűrése"
          data-testid="stream-filter"
        />

        <!-- Search field -->
        <div class="relative flex-1 min-w-0 md:max-w-sm">
          <svg
            class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            v-model="search"
            type="text"
            placeholder="Események keresése…"
            aria-label="Események keresése"
            class="h-9 w-full pl-8 pr-3 rounded-md bg-surface border border-border-subtle text-[12.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-nct-soft focus:ring-2 focus:ring-nct-500/20 transition-colors"
            data-testid="stream-search"
          />
          <button
            v-if="hasActiveFilter"
            type="button"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors"
            aria-label="Szűrők törlése"
            data-testid="stream-filter-reset"
            @click="resetFilters"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Inline ask bar -->
      <div class="px-4 md:px-6 pb-3">
        <AskBar
          v-model="q"
          size="md"
          rounded="lg"
          input-id="stream-ask-input"
          placeholder="Kérdezd a CMMS-t innen…"
          :busy="answerBusy"
          @submit="submitQuestion"
        />
      </div>
    </div>

    <!-- =================================================================
         EVENT FEED
         ================================================================= -->
    <div class="flex-1 min-h-0 overflow-y-auto" data-testid="stream-feed">
      <EmptyState
        v-if="visibleEvents.length === 0"
        title="Várakozás a bejövő kérdésekre…"
        data-testid="stream-empty"
      >
        <template #actions>
          <span class="flex items-center gap-1.5" aria-hidden="true">
            <span class="w-1.5 h-1.5 rounded-full bg-nct-soft animate-pulse" />
            <span
              class="w-1.5 h-1.5 rounded-full bg-nct-soft animate-pulse"
              style="animation-delay: 150ms"
            />
            <span
              class="w-1.5 h-1.5 rounded-full bg-nct-soft animate-pulse"
              style="animation-delay: 300ms"
            />
          </span>
        </template>
      </EmptyState>

      <ul
        v-else
        class="divide-y divide-border-subtle"
      >
        <template v-for="group in groupedEvents" :key="group.day">
          <!-- Day boundary label -->
          <li
            v-if="group.day"
            class="px-4 md:px-6 py-1.5 text-[10px] font-mono uppercase tracking-wider text-text-muted bg-canvas-2/40 border-y border-border-subtle/50"
            aria-hidden="true"
          >
            {{ group.day }}
          </li>
          <li
            v-for="(ev, idx) in group.events"
            :key="`${ev.t}-${ev.type}-${idx}`"
            class="px-4 md:px-6 py-2.5 border-l-2 transition-colors duration-150 cursor-pointer focus:outline-none focus-visible:bg-surface-2/50 focus-visible:ring-1 focus-visible:ring-nct-soft/40"
            :class="[
              eventVisual(ev).barClass,
              selected === ev ? 'bg-surface-2/70' : 'hover:bg-surface-2/30',
            ]"
            :data-testid="'stream-event'"
            :aria-label="`${eventVisual(ev).label} – ${eventVisual(ev).body}`"
            role="button"
            tabindex="0"
            @click="selectEvent(ev)"
            @keydown.enter.prevent="selectEvent(ev)"
            @keydown.space.prevent="selectEvent(ev)"
          >
            <div class="flex items-center gap-3 md:gap-4 min-w-0">
              <!-- Time -->
              <span
                class="w-16 shrink-0 font-mono text-[11px] text-text-muted tabular-nums"
              >
                {{ fmtTime(ev.t) }}
              </span>
              <!-- Type icon + label -->
              <span class="flex items-center gap-2 shrink-0">
                <span
                  class="inline-flex items-center justify-center w-5 h-5 rounded border font-mono text-[10px] font-semibold"
                  :class="eventVisual(ev).iconClass"
                  aria-hidden="true"
                >
                  <template v-if="eventVisual(ev).icon === 'q'">?</template>
                  <template v-else-if="eventVisual(ev).icon === 'a'">↳</template>
                  <template v-else-if="eventVisual(ev).icon === 'shield'">⛨</template>
                  <template v-else>·</template>
                </span>
                <span
                  class="font-mono text-[10px] uppercase tracking-wider text-text-secondary"
                  data-testid="event-type"
                >
                  {{ eventVisual(ev).label }}
                </span>
              </span>

              <!-- Status pill -->
              <span
                class="hidden md:inline-flex items-center h-5 px-1.5 rounded font-mono text-[9.5px] uppercase tracking-wider"
                :class="eventVisual(ev).statusClass"
              >
                {{ eventVisual(ev).statusLabel }}
              </span>

              <!-- Body -->
              <span
                class="min-w-0 flex-1 text-[13px] text-text-primary truncate"
                :title="eventVisual(ev).body"
                data-testid="event-body"
              >
                {{ eventVisual(ev).body || '—' }}
              </span>

              <!-- Inspect affordance -->
              <span
                class="hidden sm:inline-flex items-center text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
                aria-hidden="true"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
            </div>

            <!-- Embedded approval action bar (visible for any approval event
                 so operators can resolve inline; disabled state still
                 carries the spec title for resolved events). -->
            <div
              v-if="ev.type === 'approval'"
              class="mt-2 ml-[7.75rem] flex items-center gap-2 flex-wrap"
              data-testid="approval-actions"
              @click.stop
            >
              <span class="text-[10.5px] font-mono uppercase tracking-wider text-text-muted">
                Jóváhagyás
              </span>
              <span class="text-[12px] text-text-secondary truncate max-w-md">
                {{ ev.summary }}
              </span>
              <span class="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  disabled
                  title="A jóváhagyási sor még nincs bekötve"
                  class="h-7 px-2.5 text-[11px] font-medium rounded-md bg-success/15 text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  data-testid="approval-approve"
                >
                  Jóváhagy
                </button>
                <button
                  type="button"
                  disabled
                  title="A jóváhagyási sor még nincs bekötve"
                  class="h-7 px-2.5 text-[11px] font-medium rounded-md bg-danger/15 text-rose-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  data-testid="approval-reject"
                >
                  Elvet
                </button>
              </span>
            </div>
          </li>
        </template>
      </ul>

      <!-- =================================================================
           COLLAPSIBLE ANSWER SECTION
           ================================================================= -->
      <div
        v-if="answerOpen && (answerData || answerBusy || answerError || inlineError)"
        class="border-t border-border-subtle bg-surface-2/40"
        data-testid="stream-answer"
      >
        <div class="px-4 md:px-6 py-3 flex items-center gap-3">
          <button
            type="button"
            class="text-xs text-text-muted hover:text-text-primary transition-colors"
            data-testid="answer-toggle"
            @click="collapseAnswer"
          >
            {{ answerOpen ? '▾' : '▸' }}
          </button>
          <span class="font-mono text-[10px] uppercase tracking-wider text-nct-soft">
            Válasz
          </span>
          <span class="min-w-0 flex-1 text-[13px] text-text-primary truncate">
            {{ currentQ }}
          </span>
          <button
            type="button"
            class="text-[12px] text-nct-soft hover:text-nct-300 shrink-0"
            data-testid="show-in-ask"
            @click="showInAsk"
          >
            Megnyitás Ask-ban →
          </button>
        </div>

        <div
          v-if="answerBusy"
          class="px-4 md:px-6 pb-4 flex items-center gap-1.5"
          data-testid="answer-typing"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-nct-soft animate-pulse" />
          <span
            class="w-1.5 h-1.5 rounded-full bg-nct-soft animate-pulse"
            style="animation-delay: 150ms"
          />
          <span
            class="w-1.5 h-1.5 rounded-full bg-nct-soft animate-pulse"
            style="animation-delay: 300ms"
          />
        </div>

        <div
          v-else-if="answerError || inlineError"
          class="px-4 md:px-6 pb-4"
          data-testid="answer-error"
        >
          <div class="bg-danger/[0.08] border border-danger/25 rounded-md px-4 py-3">
            <div class="text-[13px] text-rose-200">
              {{ answerError?.title ?? 'Valami elromlott' }}
            </div>
            <div
              v-if="answerError?.description"
              class="text-[11px] text-rose-200/70 mt-1"
            >
              {{ answerError.description }}
            </div>
            <div v-if="inlineError" class="text-[11px] text-rose-200/70 mt-1">
              {{ inlineError }}
            </div>
            <Button
              variant="secondary"
              size="sm"
              class="mt-2"
              data-testid="answer-retry"
              @click="retryAnswer"
            >
              Újra
            </Button>
          </div>
        </div>

        <div v-else-if="answerData" class="px-4 md:px-6 pb-4">
          <AnswerBody
            :data="answerData"
            @run="runConfirmed"
            @refine="q = ''"
            @followup="submitQuestion"
            @sorszam-click="onStreamSorszamClick"
          />
        </div>
      </div>
    </div>

    <!-- =================================================================
         EVENT INSPECTOR (right drawer / full-screen sheet on mobile)
         ================================================================= -->
    <EventInspector
      :open="inspectorOpen"
      :event="selected"
      @update:open="inspectorOpen = $event"
      @approval-resolved="onApprovalResolved"
    />
  </div>
</template>
