<script setup lang="ts">
// src/components/tokens/AuditDetailDrawer.vue
//
// Phase 5.5 — right-side detail inspector for a single audit entry.
// Uses the shared `ResponsiveDrawer` (right edge), with sections for
// summary, event metadata, related resource, details, and technical
// payload.

import type { AuditEntry } from '@/lib/api'
import ResponsiveDrawer from '@/components/ResponsiveDrawer.vue'
import EventBadge from './EventBadge.vue'

const props = defineProps<{
  open: boolean
  entry: AuditEntry | null
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
}>()

function close() {
  emit('update:open', false)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatFull(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null) return null
  return v as Record<string, unknown>
}
</script>

<template>
  <ResponsiveDrawer
    :open="open"
    side="right"
    width-class="md:w-[420px]"
    aria-label="Audit bejegyzés részletei"
    @update:open="close"
  >
    <div v-if="entry" class="flex flex-col h-full" data-testid="audit-detail">
      <header
        class="px-4 py-3 border-b border-shell-rail-border flex items-center justify-between"
      >
        <h2 class="text-sm font-semibold">Audit bejegyzés</h2>
        <button
          type="button"
          class="h-7 w-7 inline-flex items-center justify-center rounded
                 text-text-muted hover:bg-surface-2
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Bezárás"
          data-testid="audit-detail-close"
          @click="close"
        >
          <svg viewBox="0 0 20 20" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
            <path d="m5 5 10 10M15 5 5 15" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <section data-testid="audit-detail-summary">
          <div class="flex items-center gap-2 flex-wrap">
            <EventBadge :action="String(entry.action)" />
            <span class="font-mono text-xs text-text-muted">
              {{ formatFull(entry.t) }}
            </span>
          </div>
        </section>

        <section class="space-y-2">
          <h3 class="text-[11px] uppercase tracking-wider text-text-muted">Esemény adatai</h3>
          <dl class="space-y-1.5 text-xs">
            <div class="flex items-start gap-3" data-testid="audit-detail-row">
              <dt class="w-24 shrink-0 text-text-muted">időpont</dt>
              <dd class="font-mono text-text-primary break-all" data-testid="audit-detail-value">
                {{ entry.t }}
              </dd>
            </div>
            <div class="flex items-start gap-3" data-testid="audit-detail-row">
              <dt class="w-24 shrink-0 text-text-muted">művelet</dt>
              <dd class="font-mono text-text-primary break-all" data-testid="audit-detail-value">
                {{ entry.action }}
              </dd>
            </div>
            <div class="flex items-start gap-3" data-testid="audit-detail-row">
              <dt class="w-24 shrink-0 text-text-muted">eszköz</dt>
              <dd class="font-mono text-text-primary break-all" data-testid="audit-detail-value">
                {{ entry.tool ?? '—' }}
              </dd>
            </div>
            <div class="flex items-start gap-3" data-testid="audit-detail-row">
              <dt class="w-24 shrink-0 text-text-muted">felhasználó</dt>
              <dd class="font-mono text-text-primary break-all" data-testid="audit-detail-value">
                {{ entry.user ?? '—' }}
              </dd>
            </div>
          </dl>
        </section>

        <section v-if="entry.detail" class="space-y-2">
          <h3 class="text-[11px] uppercase tracking-wider text-text-muted">Részletek</h3>
          <p class="text-sm text-text-primary whitespace-pre-wrap break-words">
            {{ entry.detail }}
          </p>
        </section>

        <section class="space-y-2">
          <h3 class="text-[11px] uppercase tracking-wider text-text-muted">Technikai adatok</h3>
          <pre
            class="text-[11px] leading-relaxed font-mono bg-canvas-2 border border-border-subtle
                   rounded-md p-3 whitespace-pre-wrap break-words"
            data-testid="audit-detail-json"
          >{{ JSON.stringify(entry, null, 2) }}</pre>
        </section>
      </div>

      <footer
        class="px-4 py-3 border-t border-shell-rail-border flex items-center justify-end"
      >
        <button
          type="button"
          class="h-9 px-3 rounded-md text-sm text-text-secondary hover:bg-surface-2
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          data-testid="audit-detail-done"
          @click="close"
        >
          Bezárás
        </button>
      </footer>
    </div>
  </ResponsiveDrawer>
</template>
