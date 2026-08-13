<script setup lang="ts">
// src/routes/TokensPage.vue
//
// Phase 5.5 — Token Portal. Spec §5.5.
//
//   - Show/hide token panel (3 × 8-char prefixes, copy buttons).
//   - "Rotate read token" is a DOCUMENTATION dialog: the server returns
//     501 today, so we surface the manual-instructions note verbatim and
//     offer a Copy button. We deliberately do NOT call rotateToken().
//   - Audit log table (newest first) with sticky header, action badges,
//     click-to-drill modal, 10s auto-refresh, Load more pagination.
//
// No raw JSON anywhere — errors go through humanizeError().

import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import Button from '@/components/Button.vue'
import Modal from '@/components/Modal.vue'
import Skeleton from '@/components/Skeleton.vue'
import { useApi } from '@/composables/useApi'
import { withAutoRetry } from '@/composables/useApiWithRetry'
import { humanizeError } from '@/lib/errors'
import type { AuditEntry } from '@/lib/api'

// The exact 501 note the server returns for POST /tokens/rotate (spec
// §2.1). v1 shows it verbatim in the Rotate dialog as documentation.
const ROTATE_INSTRUCTIONS =
  'update CMMS_API_TOKEN_READ in /etc/cmms-api.env then re-run deploy-binary.ts and deploy-mcp.ts'

const DEFAULT_AUDIT_LIMIT = 20
const AUDIT_PAGE_STEP = 20

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const showTokens = ref(false)
const rotateOpen = ref(false)
const auditLimit = ref(DEFAULT_AUDIT_LIMIT)
const selectedEntry = ref<AuditEntry | null>(null)
const copiedKey = ref<'read' | 'write' | 'bearer' | null>(null)
const instructionsCopied = ref(false)

let copyTimer: ReturnType<typeof setTimeout> | null = null
let instructionsTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const tokensQuery = useQuery({
  queryKey: ['tokens'],
  queryFn: withAutoRetry(() => useApi().tokens()),
  // Fetch lazily — only after the operator clicks "Show current tokens".
  enabled: showTokens,
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
// Token panel
// ---------------------------------------------------------------------------

interface TokenRow {
  key: 'read' | 'write' | 'bearer'
  label: string
  value: string
}

const tokenRows = computed<TokenRow[]>(() => {
  const t = tokensQuery.data.value
  return [
    { key: 'read', label: 'Read', value: t?.read_token_prefix ?? '…' },
    { key: 'write', label: 'Write', value: t?.write_token_prefix ?? '…' },
    { key: 'bearer', label: 'Bearer', value: t?.bearer_token_prefix ?? '…' },
  ]
})

const COPY_ARIA: Record<TokenRow['key'], string> = {
  read: 'Read token másolása',
  write: 'Write token másolása',
  bearer: 'Bearer token másolása',
}

// ---------------------------------------------------------------------------
// Audit table helpers
// ---------------------------------------------------------------------------

// Exact spec §5.5 badge colors. (The Badge atom lacks sky/violet/slate,
// so these are hand-rolled spans.)
const BADGE_CLASSES: Record<string, string> = {
  login: 'bg-emerald-500/15 text-emerald-300',
  logout: 'bg-slate-500/15 text-slate-300',
  login_failed: 'bg-rose-500/15 text-rose-300',
  question: 'bg-sky-500/15 text-sky-300',
  answer: 'bg-violet-500/15 text-violet-300',
  approval: 'bg-amber-500/15 text-amber-300',
  revert_request: 'bg-rose-500/15 text-rose-300',
  token_rotate_request: 'bg-surface-2 text-text-secondary',
}
const DEFAULT_BADGE = 'bg-surface-2 text-text-secondary'

function badgeClass(action: string): string {
  return BADGE_CLASSES[action] ?? DEFAULT_BADGE
}

function badgeLabel(action: string): string {
  return action.replace('_', ' ')
}

/** Audit action → emberi magyar címke a badge szövegében. */
const ACTION_LABEL_HU: Record<string, string> = {
  login: 'bejelentkezés',
  logout: 'kijelentkezés',
  login_failed: 'sikertelen bejelentkezés',
  question: 'kérdés',
  answer: 'válasz',
  approval: 'jóváhagyás',
  acquire_token: 'token szerzés',
  token_rotate_request: 'token rotáció kérés',
  revert_request: 'visszaállítás kérés',
}

function actionLabelHu(action: string): string {
  return ACTION_LABEL_HU[action] ?? action.replace('_', ' ')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** ISO -> 'YYYY-MM-DD HH:MM:SS' in local time (operator + server are both
 *  in Hungary, spec §5.4). Falls back to the raw string on bad input. */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

const detailRows = computed(() => {
  const e = selectedEntry.value
  if (!e) return []
  return [
    { label: 'idpont', value: e.t },
    { label: 'mködés', value: e.action },
    { label: 'eszköz', value: e.tool ?? '—' },
    { label: 'felhasználó', value: e.user ?? '—' },
    { label: 'részletek', value: e.detail ?? '—' },
  ]
})

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      // Fallback: hidden textarea + execCommand (older browsers / tests).
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

async function copyToken(key: TokenRow['key'], value: string) {
  await copyToClipboard(value)
  copiedKey.value = key
  if (copyTimer !== null) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copiedKey.value = null
  }, 1_500)
}

async function copyInstructions() {
  await copyToClipboard(ROTATE_INSTRUCTIONS)
  instructionsCopied.value = true
  if (instructionsTimer !== null) clearTimeout(instructionsTimer)
  instructionsTimer = setTimeout(() => {
    instructionsCopied.value = false
  }, 1_500)
}

function loadMore() {
  auditLimit.value += AUDIT_PAGE_STEP
}

function openEntry(entry: AuditEntry) {
  selectedEntry.value = entry
}
</script>

<template>
  <div class="h-full flex flex-col font-sans">
    <!-- Page header — HIG pattern (Phase 7). -->
    <header
      class="h-13 px-4 md:px-6 flex items-center justify-between gap-4 border-b border-border-subtle bg-canvas-2/60 shrink-0"
    >
      <div class="min-w-0">
        <h1 class="text-[15px] font-semibold tracking-tight text-text-primary leading-none">
          Token portál
        </h1>
        <p class="text-[12px] text-text-muted mt-1 truncate">
          Read/write tokenek API integrációkhoz · audit napló lentebb
        </p>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <Button
          variant="primary"
          size="md"
          data-testid="show-tokens-btn"
          @click="showTokens = !showTokens"
        >
          {{ showTokens ? 'Tokenek elrejtése' : 'Tokenek mutatása' }}
        </Button>
        <Button
          variant="secondary"
          size="md"
          data-testid="rotate-btn"
          @click="rotateOpen = true"
        >
          Read token rotáció
        </Button>
      </div>
    </header>

    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4">

      <!-- Token panel -->
      <div
        v-if="showTokens"
        data-testid="token-panel"
        class="bg-surface border border-border-subtle rounded-lg p-4 space-y-2 mt-4"
      >
        <!-- Loading: 3 skeleton rows -->
        <template v-if="tokensPending">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3">
            <Skeleton h="h-4" w="w-28" />
            <Skeleton h="h-4" w="w-44" />
          </div>
        </template>

        <!-- Error -->
        <div
          v-else-if="tokensError"
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

        <!-- Data -->
        <template v-else>
          <div
            v-for="row in tokenRows"
            :key="row.key"
            class="flex items-center gap-3"
            data-testid="token-row"
          >
            <span class="w-28 text-xs text-text-muted">{{ row.label }}</span>
            <span class="font-mono text-sm text-text-primary" data-testid="token-value">
              {{ row.value }}
            </span>
            <span class="text-xs text-text-muted">csak az els 8 karakter</span>
            <Button
              variant="ghost"
              size="sm"
              :aria-label="COPY_ARIA[row.key]"
              :data-testid="`token-copy-${row.key}`"
              @click="copyToken(row.key, row.value)"
            >
              {{ copiedKey === row.key ? '✓' : 'Másol' }}
            </Button>
          </div>
        </template>
      </div>

      <!-- Audit log -->
      <div
        data-testid="audit-card"
        class="bg-surface border border-border-subtle rounded-lg overflow-hidden mt-4"
      >
        <div class="max-h-[60vh] overflow-y-auto">
          <table class="w-full text-left border-separate border-spacing-0">
            <thead>
              <tr>
                <th
                  class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-40"
                >
                  Idpont
                </th>
                <th
                  class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-28"
                >
                  Mvelet
                </th>
                <th
                  class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-36"
                >
                  Eszköz
                </th>
                <th
                  class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium w-20"
                >
                  Felhasználó
                </th>
                <th
                  class="sticky top-0 z-10 bg-surface-2/80 backdrop-blur-sm border-b border-border-subtle px-4 py-2.5 text-[11px] uppercase tracking-wider text-text-muted font-medium"
                >
                  Részletek
                </th>
              </tr>
            </thead>
            <tbody>
              <!-- First load: 8 skeleton rows, alternating opacity -->
              <template v-if="auditPending">
                <tr v-for="i in 8" :key="i" :class="i % 2 === 1 ? 'opacity-50' : 'opacity-80'">
                  <td :colspan="5" class="px-4 py-1">
                    <Skeleton h="h-9" w="w-full" />
                  </td>
                </tr>
              </template>

              <!-- Error -->
              <tr v-else-if="auditError">
                <td :colspan="5" class="px-4 py-3">
                  <div class="bg-danger/[0.08] border border-danger/25 rounded-md px-4 py-3">
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
                </td>
              </tr>

              <!-- Empty -->
              <tr v-else-if="entries.length === 0" data-testid="audit-empty">
                <td :colspan="5" class="px-4 py-10">
                  <div class="flex items-center justify-center gap-2">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      class="w-4 h-4 text-text-muted"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 3" />
                    </svg>
                    <span class="text-sm text-text-muted">Még nincs audit bejegyzés</span>
                  </div>
                </td>
              </tr>

              <!-- Rows -->
              <template v-else>
                <tr
                  v-for="entry in entries"
                  :key="`${entry.t}-${entry.action}`"
                  data-testid="audit-row"
                  role="button"
                  tabindex="0"
                  class="cursor-pointer hover:bg-surface-2/60 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
                  @click="openEntry(entry)"
                  @keydown.enter.self="openEntry(entry)"
                >
                  <td
                    class="px-4 py-2 whitespace-nowrap font-mono text-xs text-text-muted tabular-nums"
                    data-testid="audit-time"
                  >
                    {{ formatTime(entry.t) }}
                  </td>
                  <td class="px-4 py-2">
                    <span
                      class="inline-flex h-5 items-center rounded-full px-2 font-mono text-[10px] uppercase tracking-wider whitespace-nowrap"
                      :class="badgeClass(entry.action)"
                      data-testid="audit-badge"
                    >
                      {{ actionLabelHu(entry.action) }}
                    </span>
                  </td>
                  <td class="px-4 py-2 font-mono text-xs text-text-secondary whitespace-nowrap">
                    {{ entry.tool ?? '—' }}
                  </td>
                  <td class="px-4 py-2 text-xs text-text-secondary whitespace-nowrap">
                    {{ entry.user ?? '—' }}
                  </td>
                  <td
                    class="px-4 py-2 text-sm text-text-secondary truncate max-w-0"
                    :title="entry.detail"
                  >
                    {{ entry.detail ?? '—' }}
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <!-- Footer -->
        <div
          v-if="auditLoaded"
          class="px-4 py-3 border-t border-border-subtle flex items-center justify-between"
        >
          <span class="text-xs text-text-muted">{{ entries.length }} bejegyzés látható</span>
          <Button variant="ghost" size="sm" data-testid="load-more-btn" @click="loadMore">
            Több betöltése
          </Button>
        </div>
      </div>
    </div>

    <!-- Read token rotáció — dokumentációs párbeszéd (a szerver 501-et ad) -->
    <Modal :open="rotateOpen" title="Read token rotáció" @update:open="rotateOpen = false">
      <p class="text-sm text-text-secondary">
        A szerver-oldali rotáció még nincs bekötve. A jelenlegi read token a szerver környezeti változójában él:
      </p>
      <pre
        data-testid="rotate-note"
        class="mt-3 bg-canvas-2 border border-border-subtle rounded-md p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-text-primary"
      >{{ ROTATE_INSTRUCTIONS }}</pre>
      <div class="mt-3">
        <Button
          variant="secondary"
          size="sm"
          data-testid="copy-instructions-btn"
          @click="copyInstructions"
        >
          {{ instructionsCopied ? 'Másolva ✓' : 'Utasítások másolása' }}
        </Button>
      </div>
      <template #footer>
        <Button variant="ghost" data-testid="modal-close-btn" @click="rotateOpen = false">
          Bezárás
        </Button>
      </template>
    </Modal>

    <!-- Audit bejegyzés ráközelítés -->
    <Modal :open="selectedEntry !== null" title="Audit bejegyzés" @update:open="selectedEntry = null">
      <div v-if="selectedEntry" class="space-y-2" data-testid="audit-modal">
        <div
          v-for="row in detailRows"
          :key="row.label"
          class="flex items-start gap-3"
          data-testid="audit-detail-row"
        >
          <span class="w-28 shrink-0 text-xs text-text-muted">{{ row.label }}</span>
          <span class="font-mono text-xs text-text-primary break-all" data-testid="audit-detail-value">
            {{ row.value }}
          </span>
        </div>
      </div>
    </Modal>
  </div>
</template>