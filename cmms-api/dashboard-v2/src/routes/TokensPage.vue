<script setup lang="ts">
// src/routes/TokensPage.vue
//
// Phase 5.5 — Tokenek kezelése és biztonsági eseménynapló.
//
// Layout (top → bottom):
//   1. Page header: title + subtitle + two header actions
//      ("Tokenek megjelenítése" + "Token rotáció részletei")
//   2. Security summary (4 tiles) — real data only
//   3. Token management (collapsible) — masked prefixes + env hints
//   4. Audit history header + filter chips + search
//   5. Audit table (desktop) / audit cards (mobile)
//   6. Load-more footer
//   7. Detail drawer (right-side)
//   8. Rotation info dialog (501 stub)
//
// We do NOT call the rotate API — it returns 501 today. The dialog
// is purely informational; users get the verbatim note and a copy
// button.

import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { humanizeError } from '@/lib/errors'
import { matchesGroup, type EventGroup } from '@/components/tokens/eventGrammar'
import TokenSummary from '@/components/tokens/TokenSummary.vue'
import TokenList from '@/components/tokens/TokenList.vue'
import AuditFilters from '@/components/tokens/AuditFilters.vue'
import AuditTable from '@/components/tokens/AuditTable.vue'
import AuditDetailDrawer from '@/components/tokens/AuditDetailDrawer.vue'
import TokenRotationDialog from '@/components/tokens/TokenRotationDialog.vue'
import Button from '@/components/Button.vue'
import type { AuditEntry } from '@/lib/api'

const DEFAULT_AUDIT_LIMIT = 20
const AUDIT_PAGE_STEP = 20
const ROTATE_INSTRUCTIONS =
  'update CMMS_API_TOKEN_READ in /etc/cmms-api.env then re-run deploy-binary.ts and deploy-mcp.ts'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const tokenListOpen = ref(false)
const rotateOpen = ref(false)
const auditLimit = ref(DEFAULT_AUDIT_LIMIT)
const selectedEntry = ref<AuditEntry | null>(null)
const detailOpen = ref(false)

const search = ref('')
const groupFilter = ref<EventGroup | null>(null)
const instructionsCopied = ref(false)

let instructionsTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const tokensQuery = useQuery({
  queryKey: ['tokens'],
  queryFn: withAutoRetry(() => useApi().tokens()),
  // Fetch lazily — only after the operator clicks "Tokenek megjelenítése".
  enabled: tokenListOpen,
})

const auditQuery = useQuery({
  queryKey: ['audit', auditLimit],
  queryFn: withAutoRetry(() => useApi().audit(auditLimit.value)),
  refetchInterval: 10_000,
  refetchIntervalInBackground: false,
})

const entries = computed(() => auditQuery.data.value?.entries ?? [])
const auditLoaded = computed(() => auditQuery.data.value !== undefined)
const auditPending = computed(() => auditQuery.isPending.value)
const auditError = computed(() =>
  auditQuery.isError.value ? humanizeError(auditQuery.error.value) : null,
)

const tokensPending = computed(() => tokensQuery.isPending.value)
const tokensError = computed(() =>
  tokensQuery.isError.value ? humanizeError(tokensQuery.error.value) : null,
)

// ---------------------------------------------------------------------------
// Filtering (client-side over the loaded audit set)
// ---------------------------------------------------------------------------

const filteredEntries = computed<AuditEntry[]>(() => {
  const q = search.value.trim().toLowerCase()
  return entries.value.filter((e) => {
    if (!matchesGroup(String(e.action), groupFilter.value)) return false
    if (q.length === 0) return true
    const hay = [
      String(e.action ?? ''),
      String(e.tool ?? ''),
      String(e.user ?? ''),
      String(e.detail ?? ''),
      String(e.t ?? ''),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
})

const hasActiveFilters = computed(
  () => search.value.trim().length > 0 || groupFilter.value !== null,
)

const tokenCount = computed(() => {
  if (!tokensQuery.data.value) return 0
  return Object.values(tokensQuery.data.value).filter((v) => typeof v === 'string' && v.length > 0).length
})

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function clearFilters() {
  search.value = ''
  groupFilter.value = null
}

function loadMore() {
  auditLimit.value += AUDIT_PAGE_STEP
}

function openEntry(entry: AuditEntry) {
  selectedEntry.value = entry
  detailOpen.value = true
}

function closeEntry() {
  detailOpen.value = false
}

function toggleTokenList() {
  tokenListOpen.value = !tokenListOpen.value
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
  } catch {
    // Clipboard unavailable — flash the success state optimistically.
  }
}

async function copyInstructions() {
  await copyToClipboard(ROTATE_INSTRUCTIONS)
  instructionsCopied.value = true
  if (instructionsTimer !== null) clearTimeout(instructionsTimer)
  instructionsTimer = setTimeout(() => {
    instructionsCopied.value = false
  }, 1_500)
}
</script>

<template>
  <div class="h-full flex flex-col font-sans">
    <!-- Page header -->
    <header
      class="px-4 md:px-6 py-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between
             border-b border-border-subtle bg-canvas-2/60 shrink-0"
    >
      <div class="min-w-0">
        <h1
          class="text-[20px] font-semibold tracking-tight text-text-primary leading-none"
        >
          Tokenek
        </h1>
        <p class="text-sm text-text-muted mt-2">
          API-tokenek kezelése és biztonsági eseménynapló
        </p>
        <p class="text-[11px] uppercase tracking-wider text-text-muted mt-2">
          Token portál
        </p>
      </div>
      <div class="flex flex-col sm:flex-row items-start sm:items-center gap-2 shrink-0">
        <Button
          variant="primary"
          size="md"
          data-testid="show-tokens-btn"
          :aria-expanded="tokenListOpen"
          aria-controls="token-panel"
          @click="toggleTokenList"
        >
          {{ tokenListOpen ? 'Tokenek elrejtése' : 'Tokenek megjelenítése' }}
        </Button>
        <Button
          variant="secondary"
          size="md"
          data-testid="rotate-btn"
          @click="rotateOpen = true"
        >
          Token rotáció részletei
        </Button>
      </div>
    </header>

    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-5 space-y-5">
      <!-- Security summary -->
      <TokenSummary
        :entries="entries"
        :loading="auditPending && !auditLoaded"
        :tokens-loaded="tokenListOpen && !!tokensQuery.data.value"
        :token-count="tokenCount"
      />

      <!-- Token management panel (lazy-fetched) -->
      <div
        v-if="tokenListOpen"
        id="token-panel"
        data-testid="token-panel"
        class="space-y-3"
      >
        <div
          v-if="tokensError"
          data-testid="token-error"
          class="bg-rose-500/[0.08] border border-rose-500/30 rounded-md px-4 py-3"
        >
          <div class="text-sm text-rose-200">{{ tokensError.title }}</div>
          <div class="text-xs text-rose-200/70 mt-1">{{ tokensError.description }}</div>
          <Button
            variant="ghost"
            size="sm"
            class="mt-2"
            data-testid="token-retry-btn"
            @click="tokensQuery.refetch()"
          >
            Újra
          </Button>
        </div>

        <TokenList
          v-else
          :tokens="tokensQuery.data.value"
          :loading="tokensPending"
          @copy="async ({ value }) => { await copyToClipboard(value) }"
        />
      </div>

      <!-- Audit history header -->
      <section class="space-y-3">
        <header>
          <h2 class="text-base font-semibold text-text-primary">
            Biztonsági eseménynapló
          </h2>
          <p class="text-xs text-text-muted mt-1">
            Tokenekhez és API-hozzáférésekhez kapcsolódó események
          </p>
        </header>

        <!-- Error / loading banner (one row, not inside the table) -->
        <div
          v-if="auditError"
          data-testid="audit-error"
          class="bg-rose-500/[0.08] border border-rose-500/30 rounded-md px-4 py-3"
        >
          <div class="text-sm text-rose-200">{{ auditError.title }}</div>
          <div class="text-xs text-rose-200/70 mt-1">{{ auditError.description }}</div>
          <Button
            variant="ghost"
            size="sm"
            class="mt-2"
            data-testid="audit-retry-btn"
            @click="auditQuery.refetch()"
          >
            Újra
          </Button>
        </div>

        <AuditFilters
          v-else-if="auditLoaded"
          :search="search"
          :group="groupFilter"
          :has-active-filters="hasActiveFilters"
          :visible-count="filteredEntries.length"
          :total-count="entries.length"
          @update:search="(v: string) => (search = v)"
          @update:group="(v: EventGroup | null) => (groupFilter = v)"
          @clear="clearFilters"
        />

        <AuditTable
          :entries="filteredEntries"
          :loading="auditPending && !auditLoaded"
          :empty="auditLoaded && filteredEntries.length === 0"
          @open="openEntry"
          @load-more="loadMore"
          @retry="auditQuery.refetch()"
        />
      </section>
    </div>

    <!-- Audit detail drawer (right edge) -->
    <AuditDetailDrawer
      v-model:open="detailOpen"
      :entry="selectedEntry"
    />

    <!-- Token rotation info dialog (501 stub — informational only) -->
    <TokenRotationDialog
      v-model:open="rotateOpen"
      :copied="instructionsCopied"
      @copy="copyInstructions"
    />
  </div>
</template>
