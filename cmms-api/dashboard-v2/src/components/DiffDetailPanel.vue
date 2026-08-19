<script setup lang="ts">
// src/components/DiffDetailPanel.vue
//
// Right-side inspector for a single change row. Wraps the existing
// <ResponsiveDrawer> primitive so it gets escape-to-close, focus
// management, body scroll lock, and the mobile bottom-sheet variant
// for free.
//
// Content:
//   - Header:  category badge + action + sorszam-style id
//   - Meta:    comparison range (Korábbi → Jelenlegi), timestamp
//   - Body:    before / after side-by-side (or stacked on mobile)
//   - Footer:  "Ticket megnyitása" + optional "Visszaállítás" button
//
// Restore behaviour: only shown if `restorable === true` AND
// `restoring === false`. The button is intentionally not styled as a
// primary destructive action — it uses the brand-purple surface so
// it matches the rest of the dashboard, but we add a confirmation
// dialog upstream.
import { computed } from 'vue'
import ResponsiveDrawer from '@/components/ResponsiveDrawer.vue'
import Button from '@/components/Button.vue'
import Badge from '@/components/Badge.vue'
import type { DiffChange } from '@/lib/api'
import {
  actionLabel,
  categorizeChange,
  formatHuDateTimeWithZone,
  formatIsoMonospace,
  safeStringify,
  truncate,
} from '@/lib/diff'
import type { DiffCategory } from '@/lib/diff'

const props = defineProps<{
  open: boolean
  change: DiffChange | null
  /** When the panel is open for a change that the wire shape marks
   *  as restorable. Currently always false — the /api/diff stub does
   *  not include restorable data. */
  restorable?: boolean
  restoring?: boolean
  /** The baseline ISO used for the loaded diff. */
  since: string | null
  /** The "now" ISO captured at fetch time. */
  now: string | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'view-ticket', id: string): void
  (e: 'restore', id: string): void
}>()

const category = computed<DiffCategory>(() =>
  props.change ? categorizeChange(props.change) : 'other',
)
const categoryLabel: Record<DiffCategory, string> = {
  added: 'Hozzáadva',
  modified: 'Módosítva',
  deleted: 'Törölve',
  other: 'Egyéb',
}
const actionHuman = computed(() =>
  props.change ? actionLabel(props.change.action) : '',
)
const snippet = computed(() =>
  props.change ? truncate(String(props.change.after ?? ''), 400) : '',
)
const beforeText = computed(() =>
  props.change && props.change.before !== null && props.change.before !== undefined
    ? safeStringify(props.change.before, 4_000)
    : null,
)
const afterText = computed(() =>
  props.change ? safeStringify(props.change.after, 4_000) : '',
)

function close() {
  emit('update:open', false)
}
function viewTicket() {
  if (props.change) emit('view-ticket', props.change.id)
}
function restore() {
  if (props.change) emit('restore', props.change.id)
}
</script>

<template>
  <ResponsiveDrawer
    :open="open"
    side="right"
    width-class="md:w-[420px]"
    aria-label="Változás részletei"
    @update:open="(v) => emit('update:open', v)"
  >
    <template v-if="change">
      <div class="flex-1 overflow-y-auto">
        <header
          class="px-5 py-4 border-b border-shell-rail-border sticky top-0 bg-shell-rail z-10"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <p class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
                Változás részletei
              </p>
              <h2 class="mt-1 text-base font-semibold text-text-primary leading-tight truncate">
                {{ categoryLabel[category] }} · {{ actionHuman }}
              </h2>
              <p
                class="mt-1 font-mono text-[12px] text-nct-soft truncate"
                data-testid="detail-id"
              >
                {{ change.id }}
              </p>
            </div>
            <button
              type="button"
              class="shrink-0 w-8 h-8 -mt-1 -mr-1 rounded-full flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-nct-soft/40"
              aria-label="Bezárás"
              data-testid="detail-close"
              @click="close"
            >
              <svg
                class="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        <div class="px-5 py-4 space-y-5">
          <!-- Meta -->
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[12px]">
            <dt class="text-text-muted font-mono uppercase tracking-wider text-[10px]">Entitás</dt>
            <dd class="text-text-primary font-mono">{{ change.entity }}</dd>
            <dt class="text-text-muted font-mono uppercase tracking-wider text-[10px]">Akció</dt>
            <dd>
              <Badge :label="actionHuman" variant="default" />
            </dd>
            <dt class="text-text-muted font-mono uppercase tracking-wider text-[10px]">Időpont</dt>
            <dd class="text-text-primary font-mono" :title="change.t">
              {{ formatIsoMonospace(change.t) }}
            </dd>
            <dt class="text-text-muted font-mono uppercase tracking-wider text-[10px]">Ablak</dt>
            <dd class="text-text-primary font-mono">
              <span v-if="since">{{ formatHuDateTimeWithZone(since) }}</span>
              <span v-else>—</span>
              <span class="mx-1 text-text-muted" aria-hidden="true">→</span>
              <span v-if="now">{{ formatHuDateTimeWithZone(now) }}</span>
              <span v-else>most</span>
            </dd>
          </dl>

          <!-- Snippet -->
          <div v-if="snippet">
            <p class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
              Összefoglaló
            </p>
            <p class="text-[13px] text-text-secondary leading-relaxed">{{ snippet }}</p>
          </div>

          <!-- Before / After -->
          <div class="space-y-3">
            <div>
              <p class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
                Korábbi érték
              </p>
              <pre
                v-if="beforeText"
                class="font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-text-secondary bg-canvas-2/60 border border-border-subtle rounded-md p-3"
              >{{ beforeText }}</pre>
              <p v-else class="text-[12px] text-text-muted italic">
                A korábbi érték nem áll rendelkezésre ennél a rekordnál.
              </p>
            </div>
            <div>
              <p class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
                Jelenlegi érték
              </p>
              <pre
                class="font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-text-secondary bg-canvas-2/60 border border-border-subtle rounded-md p-3"
              >{{ afterText }}</pre>
            </div>
          </div>

          <!-- Safety note -->
          <div
            class="rounded-md border border-border-subtle bg-canvas-2/40 px-3 py-2.5"
            data-testid="detail-safety"
          >
            <p class="text-[11px] text-text-muted leading-relaxed">
              <span class="font-mono uppercase tracking-wider text-text-secondary">Megjegyzés · </span>
              A visszaállítás csak akkor elérhető, ha a kiválasztott rekord
              szerveroldalon visszaállíthatónak van jelölve, és a
              munkameneted rendelkezik a megfelelő jogosultsággal. A
              művelet nem visszavonható.
            </p>
          </div>
        </div>
      </div>

      <footer
        class="px-5 py-3 border-t border-shell-rail-border bg-shell-rail flex items-center justify-between gap-3 shrink-0"
      >
        <Button
          variant="ghost"
          size="sm"
          data-testid="detail-view-ticket"
          @click="viewTicket"
        >
          Ticket megnyitása →
        </Button>
        <Button
          v-if="restorable"
          variant="primary"
          size="sm"
          class="!bg-nct-500 hover:!bg-nct-600 focus-visible:!ring-nct-soft/50"
          :loading="restoring"
          :disabled="restoring"
          data-testid="detail-restore"
          @click="restore"
        >
          Visszaállítás
        </Button>
        <span
          v-else
          class="text-[11px] text-text-muted"
          data-testid="detail-restore-unavailable"
        >
          Visszaállítás nem elérhető
        </span>
      </footer>
    </template>
  </ResponsiveDrawer>
</template>
