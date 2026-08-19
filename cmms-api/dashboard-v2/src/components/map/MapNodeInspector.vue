<script setup lang="ts">
// src/components/map/MapNodeInspector.vue
//
// Side sheet that opens when the user clicks a node on the Map page.
// Mirrors the visual + a11y pattern of TicketInspector:
//   - Desktop (>= md): slides in from the right, 400px wide.
//   - Mobile (< md): bottom sheet, 88dvh, full width.
//
// Content:
//   - Header: machine label + family + ticket count
//   - "Minta ticketek" section — shows the server-baked samples
//     attached to the node, OR (when empty) fires an on-demand
//     /v1/jobs/search keyed on [node.id, period] and shows real
//     results. The two states blend seamlessly: by the time the
//     skeleton disappears, the same list shape is rendered.
//   - "Related machines" — every other node in the same family.
//     Clicking one emits `select-node` so the parent can center the
//     graph on the related machine.
//   - "Összes megtekintése Ask-ban →" CTA when the search returned
//     results, so the user can pivot to a full Ask query for the
//     same device.

import { computed, onBeforeUnmount, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useApi } from '@/composables/useApi'
import type { EvidenceTicket } from '@/lib/api'
import type { NormalizedMapNode } from '@/lib/mapNormalization'
import { setSeedQ } from '@/composables/useSeedQ'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a 200-char snippet from a free-text job body. Strips the
 * question's leading whitespace + newlines and truncates with a single
 * char ellipsis (matches the answer.ts pattern but cleaner).
 */
function buildJobSnippet(text: string | null | undefined, maxLen = 200): string {
  if (!text) return ''
  const cleaned = String(text).replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, maxLen - 1) + '…'
}

/**
 * Project a /v1/jobs/search response into the MapSample shape the
 * inspector renders. The search response uses a slightly different
 * field name (reported_text vs snippet, key vs sorszam), so we
 * normalise here.
 */
function jobsResponseToSamples(jobs: unknown): EvidenceTicket[] {
  if (!Array.isArray(jobs)) return []
  const out: EvidenceTicket[] = []
  for (const j of jobs) {
    if (!j || typeof j !== 'object') continue
    const row = j as Record<string, unknown>
    const sorszam = String(row.sorszam ?? row.key ?? '').trim()
    if (!sorszam) continue
    out.push({
      sorszam,
      key: sorszam,
      reported_at_iso:
        typeof row.reported_at_iso === 'string'
          ? row.reported_at_iso
          : typeof row.reported_at === 'string'
            ? row.reported_at
            : '',
      snippet: buildJobSnippet(
        (row.snippet as string | undefined) ??
          (row.reported_text as string | undefined) ??
          (row.description as string | undefined) ??
          '',
      ),
      kategoria:
        (row.kategoria as string | null | undefined) ??
        (row.problem_kategoria as string | null | undefined) ??
        null,
      kategoria_inferred:
        (row.kategoria_inferred as string | null | undefined) ?? null,
      sulyossag_inferred:
        (row.sulyossag_inferred as string | null | undefined) ?? null,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Props / emits
// ---------------------------------------------------------------------------

const props = defineProps<{
  open: boolean
  node: NormalizedMapNode | null
  allNodes: NormalizedMapNode[]
  period: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'select-node', id: string): void
  (e: 'sorszam-click', payload: { prefix: 'B' | 'M'; sorszam: string }): void
}>()

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const relatedNodes = computed<NormalizedMapNode[]>(() => {
  if (!props.node) return []
  const idSet = new Set(props.node.relatedIds)
  return props.allNodes.filter((n) => idSet.has(n.id))
})

/** Server-baked samples (1-2 evidence tickets, present only for
 *  high-volume groups). Empty for low-volume nodes. */
const builtInSamples = computed<EvidenceTicket[]>(() => {
  if (!props.node) return []
  return props.node.samples
    .filter((s) => s.sorszam)
    .map<EvidenceTicket>((s) => ({
      sorszam: s.sorszam,
      key: s.sorszam,
      reported_at_iso: s.reported_at_iso ?? '',
      snippet: s.snippet,
      kategoria: s.kategoria,
      kategoria_inferred: s.kategoria_inferred,
      sulyossag_inferred: s.sulyossag_inferred,
    }))
})

/** Whether we need to fire an on-demand search for this node.
 *  True when: node is set, has empty builtInSamples, AND the inspector
 *  is open (so we don't burn requests on backgrounded selections). */
const needsOnDemand = computed<boolean>(() => {
  return Boolean(props.node && props.open && builtInSamples.value.length === 0)
})

// ---------------------------------------------------------------------------
// On-demand search via TanStack Query
// ---------------------------------------------------------------------------

const onDemandQuery = useQuery({
  queryKey: computed(() => ['map-related-tickets', props.node?.id ?? '', props.period]) as unknown as readonly unknown[],
  queryFn: async () => {
    if (!props.node) return [] as EvidenceTicket[]
    const api = useApi()
    const resp = (await api.searchJobs({
      device: props.node.label,
      period: props.period,
      limit: 6,
    })) as { jobs?: unknown[]; results?: unknown[] } | unknown[]
    const list = Array.isArray(resp)
      ? resp
      : ((resp as { jobs?: unknown[]; results?: unknown[] }).jobs ??
        (resp as { jobs?: unknown[]; results?: unknown[] }).results ??
        [])
    return jobsResponseToSamples(list)
  },
  enabled: needsOnDemand,
  staleTime: 30_000,
  retry: 1,
})

const fetchedSamples = computed<EvidenceTicket[]>(() => {
  return (onDemandQuery.data.value as EvidenceTicket[] | undefined) ?? []
})

/** Final sample list shown in the inspector. Built-in wins when
 *  available; otherwise we fall back to the on-demand fetch. */
const sampleTickets = computed<EvidenceTicket[]>(() => {
  if (builtInSamples.value.length > 0) return builtInSamples.value
  return fetchedSamples.value
})

const isLoadingSamples = computed<boolean>(
  () => needsOnDemand.value && onDemandQuery.isFetching.value,
)
const hasErrorSamples = computed<boolean>(
  () => needsOnDemand.value && onDemandQuery.isError.value,
)
const fetchedTotal = computed<number>(() => {
  const raw = onDemandQuery.data.value
  if (!raw) return 0
  return Array.isArray(raw) ? raw.length : 0
})

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function close() {
  emit('update:open', false)
}

function onKeydown(evt: KeyboardEvent) {
  if (evt.key === 'Escape' && props.open) {
    evt.stopPropagation()
    close()
  }
}

function onSampleClick(sample: { sorszam: string }) {
  // Detect prefix from the sorszam string itself. B = ticket
  // (opens TicketInspector), M = device id (ignored — the parent
  // MapPage only handles 'B' tickets per the existing code path).
  const raw = (sample.sorszam || '').trim()
  if (!raw) return
  const upper = raw.toUpperCase()
  let prefix: 'B' | 'M' = 'B'
  if (upper.startsWith('B')) prefix = 'B'
  else if (upper.startsWith('M')) prefix = 'M'
  const digits = raw.replace(/^[BM]-?/i, '')
  const sorszam = `${prefix}${digits}`
  emit('sorszam-click', { prefix, sorszam })
}

function onRelatedClick(id: string) {
  emit('select-node', id)
}

function onRefreshSamples() {
  onDemandQuery.refetch()
}

function onViewAllInAsk() {
  if (!props.node) return
  setSeedQ(`device: ${props.node.label}`)
  close()
}

function onRetry() {
  onDemandQuery.refetch()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 bg-black/55 backdrop-blur-md transition-opacity duration-150"
      aria-hidden="true"
      data-testid="map-node-inspector-backdrop"
      @click="close"
    />

    <aside
      v-if="open"
      role="dialog"
      aria-modal="true"
      :aria-label="node ? `Géptípus: ${node.label}` : 'Géptípus részletek'"
      class="fixed z-50 bg-canvas-2 border-border-default shadow-2xl shadow-black/60 flex flex-col overflow-hidden"
      :class="
        'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-2xl border-t ' +
        'pb-[max(0px,env(safe-area-inset-bottom))] ' +
        'md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:max-h-none md:w-[400px] md:rounded-none md:border-l md:border-t-0 md:pb-0'
      "
      data-testid="map-node-inspector"
    >
      <!-- Mobile grab handle -->
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
            Géptípus adatai
          </div>
          <h2 class="mt-0.5 text-[15px] font-semibold text-text-primary leading-tight truncate">
            <span
              class="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle"
              :style="{ backgroundColor: node?.color ?? '#888' }"
              aria-hidden="true"
            />
            {{ node?.label ?? '—' }}
          </h2>
          <div class="mt-1 flex items-center gap-2 text-[11px] font-mono text-text-muted">
            <span
              class="px-1.5 py-0.5 rounded bg-surface-2 border border-border-subtle text-text-secondary"
            >
              Család: {{ node?.familyLabel ?? '—' }}
            </span>
            <span aria-hidden="true">·</span>
            <span class="tabular-nums">
              {{ node?.tickets.toLocaleString('hu-HU') ?? '0' }} ticket
            </span>
            <span v-if="!node?.isSingleton && relatedNodes.length > 0" aria-hidden="true">·</span>
            <span
              v-if="!node?.isSingleton && relatedNodes.length > 0"
              class="text-text-muted"
            >
              {{ relatedNodes.length }} családtárs
            </span>
          </div>
        </div>
        <button
          type="button"
          class="w-7 h-7 -mr-1 rounded-md border border-border-subtle bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors duration-150 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Bezárás"
          data-testid="map-node-inspector-close"
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
      <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 text-sm">
        <!-- Loading skeleton (on-demand fetch in flight) -->
        <section
          v-if="isLoadingSamples"
          class="mb-5"
          data-testid="map-inspector-samples-loading"
        >
          <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-2">
            Minta ticketek
          </div>
          <ul class="space-y-1.5">
            <li
              v-for="i in 3"
              :key="i"
              class="rounded-md border border-border-subtle bg-surface p-3 animate-pulse"
            >
              <div class="h-3 w-24 bg-surface-2 rounded mb-2" />
              <div class="h-2.5 w-full bg-surface-2 rounded mb-1" />
              <div class="h-2.5 w-2/3 bg-surface-2 rounded" />
            </li>
          </ul>
          <p class="mt-2 text-[11px] text-text-muted font-mono">
            Kapcsolódó ticketek keresése…
          </p>
        </section>

        <!-- Error state (on-demand fetch failed) -->
        <section
          v-else-if="hasErrorSamples"
          class="mb-5"
          data-testid="map-inspector-samples-error"
        >
          <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-2">
            Minta ticketek
          </div>
          <div class="rounded-md border border-danger/30 bg-danger/5 p-3 text-[12px] text-text-secondary">
            <p class="text-text-primary font-medium mb-1">
              Nem sikerült mintát lekérni ehhez a géptípushoz.
            </p>
            <p class="text-text-muted mb-2.5">
              A hálózat vagy a szerver átmenetileg nem elérhető.
            </p>
            <button
              type="button"
              class="text-[11px] font-medium text-accent hover:text-accent-hover transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
              data-testid="map-inspector-retry"
              @click="onRetry"
            >
              Újrapróbálkozás →
            </button>
          </div>
        </section>

        <!-- Sample tickets (built-in OR on-demand result) -->
        <section v-else-if="sampleTickets.length > 0" class="mb-5">
          <div
            class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-2 flex items-center justify-between"
          >
            <span>Minta ticketek ({{ sampleTickets.length }})</span>
            <button
              v-if="needsOnDemand && !isLoadingSamples"
              type="button"
              class="text-[10px] font-mono text-accent hover:text-accent-hover transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
              data-testid="map-inspector-refresh-samples"
              @click="onRefreshSamples"
            >
              Frissítés
            </button>
          </div>
          <ul class="space-y-1.5" data-testid="map-node-inspector-samples">
            <li
              v-for="(s, i) in sampleTickets"
              :key="`${s.sorszam}-${i}`"
              class="rounded-md border border-border-subtle bg-surface hover:border-border-default transition-colors duration-150"
            >
              <button
                type="button"
                class="w-full text-left px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-md"
                :data-testid="`map-node-inspector-sample-${s.sorszam}`"
                @click="onSampleClick(s)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="font-mono text-[12px] text-accent truncate">
                    {{ s.sorszam }}
                  </span>
                  <span
                    v-if="s.reported_at_iso"
                    class="text-[10px] font-mono text-text-muted shrink-0 tabular-nums"
                  >
                    {{
                      (() => {
                        const d = new Date(s.reported_at_iso)
                        return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
                      })()
                    }}
                  </span>
                </div>
                <p
                  v-if="s.snippet"
                  class="mt-1 text-[11px] text-text-muted line-clamp-2 leading-snug"
                >
                  {{ s.snippet }}
                </p>
              </button>
            </li>
          </ul>

          <!-- "View all in Ask" CTA — only when we have a real result
               (built-in or on-demand). The CTA is what carries the
               user to a full search of the same device. -->
          <button
            v-if="node"
            type="button"
            class="mt-2 w-full text-left text-[11px] text-accent hover:text-accent-hover transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded px-1 py-1"
            data-testid="map-inspector-view-all-ask"
            @click="onViewAllInAsk"
          >
            Összes ticket keresése Ask-ban →
          </button>
        </section>

        <!-- Empty state — node has no built-in samples AND no on-demand
             samples (e.g. period is empty, or device filter matched
             nothing). -->
        <section
          v-else-if="node"
          class="mb-5"
          data-testid="map-inspector-samples-empty"
        >
          <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-2">
            Minta ticketek (0)
          </div>
          <p class="text-[12px] text-text-muted">
            Ehhez a géptípushoz ebben az időszakban nem érhető el közvetlen minta-ticket.
          </p>
          <button
            v-if="node"
            type="button"
            class="mt-2 w-full text-left text-[11px] text-accent hover:text-accent-hover transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded px-1 py-1"
            data-testid="map-inspector-view-all-ask-empty"
            @click="onViewAllInAsk"
          >
            Összes ticket keresése Ask-ban →
          </button>
        </section>

        <!-- Related machines (same family) -->
        <section v-if="relatedNodes.length > 0" class="mb-2">
          <div
            class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-2"
          >
            Azonos gépcsalád tagjai ({{ relatedNodes.length }})
          </div>
          <ul class="space-y-1" data-testid="map-node-inspector-related">
            <li
              v-for="r in relatedNodes"
              :key="r.id"
            >
              <button
                type="button"
                class="w-full text-left px-3 py-2 rounded-md border border-border-subtle bg-surface hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                :data-testid="`map-node-inspector-related-${r.id}`"
                @click="onRelatedClick(r.id)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="flex items-center gap-2 min-w-0">
                    <span
                      class="shrink-0 rounded-full"
                      :style="{ width: '8px', height: '8px', backgroundColor: r.color }"
                      aria-hidden="true"
                    />
                    <span class="truncate text-text-primary text-[12px]">
                      {{ r.label }}
                    </span>
                  </span>
                  <span class="font-mono text-[11px] text-text-muted tabular-nums shrink-0">
                    {{ r.tickets.toLocaleString('hu-HU') }}
                  </span>
                </div>
              </button>
            </li>
          </ul>
        </section>

        <!-- Empty state when no node is selected -->
        <div
          v-if="!node"
          class="flex flex-col items-center justify-center py-10 text-center"
          data-testid="map-node-inspector-empty"
        >
          <p class="text-xs text-text-muted">Nincs kiválasztott gép.</p>
        </div>
      </div>
    </aside>
  </Teleport>
</template>
