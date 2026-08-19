<script setup lang="ts">
// src/components/EventInspector.vue
//
// Right-side drawer / full-screen sheet that shows detailed payload
// for a single stream event.
//
// - Renders inside ResponsiveDrawer (right side, 420px on desktop, full
//   width on mobile).
// - data-testid="event-inspector" is on the INNER div, not the drawer
//   wrapper, because the drawer is a Teleport root and does not
//   auto-inherit fallthrough attributes.
// - The close button is data-testid="inspector-close".
// - Authorisation tokens, passwords, secrets, and keys are redacted
//   before display in the JSON viewer.

import { computed, ref } from 'vue'
import ApprovalRequestCard from '@/components/ApprovalRequestCard.vue'
import ResponsiveDrawer from '@/components/ResponsiveDrawer.vue'
import type { StreamApprovalEvent, StreamEvent } from '@/lib/api'

const props = defineProps<{
  open: boolean
  event: StreamEvent | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'approval-resolved', payload: { id: string; approved: boolean }): void
}>()

const copied = ref(false)

function close() {
  emit('update:open', false)
}

function fmtFullTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('hu-HU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function eventTypeLabel(type?: string): string {
  switch (type) {
    case 'question':
      return 'KÉRDÉS'
    case 'answer':
      return 'VÁLASZ'
    case 'approval':
      return 'JÓVÁHAGYÁS'
    case 'tool':
      return 'AI-MŰVELET'
    case 'error':
      return 'HIBA'
    default:
      return (type || 'ESEMÉNY').toUpperCase()
  }
}

function eventTypeBadgeClass(type?: string): string {
  switch (type) {
    case 'question':
      return 'bg-nct-500/15 text-nct-soft border-nct-500/30'
    case 'answer':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    case 'approval':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30'
    case 'tool':
      return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
    case 'error':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/30'
    default:
      return 'bg-surface-2 text-text-secondary border-border-default'
  }
}

// Recursively redact authorisation headers, secrets, and key-like
// fields before showing the raw JSON payload.
const sanitizedJson = computed(() => {
  if (!props.event) return ''
  const copy = JSON.parse(JSON.stringify(props.event))
  const redact = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    for (const key of Object.keys(obj)) {
      if (/token|password|auth|secret|key/i.test(key) && typeof obj[key] === 'string') {
        obj[key] = '***REDACTED***'
      } else if (typeof obj[key] === 'object') {
        redact(obj[key])
      }
    }
  }
  redact(copy)
  return JSON.stringify(copy, null, 2)
})

async function copyPayload() {
  if (!sanitizedJson.value) return
  try {
    await navigator.clipboard.writeText(sanitizedJson.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    /* ignore clipboard failures */
  }
}
</script>

<template>
  <ResponsiveDrawer
    :open="open"
    side="right"
    width-class="md:w-[420px]"
    aria-label="Esemény részletei"
    @update:open="emit('update:open', $event)"
  >
    <div
      v-if="event"
      class="flex flex-col h-full bg-surface text-text-primary"
      data-testid="event-inspector"
    >
      <!-- Header -->
      <div class="px-5 py-4 border-b border-border-subtle flex items-center justify-between gap-3 shrink-0 bg-canvas-2/40">
        <div class="flex items-center gap-2.5 min-w-0">
          <span
            class="px-2 py-0.5 rounded font-mono text-[10.5px] uppercase font-bold tracking-wider border"
            :class="eventTypeBadgeClass(event.type)"
          >
            {{ eventTypeLabel(event.type) }}
          </span>
          <span class="font-mono text-[11px] text-text-muted truncate">
            {{ fmtFullTime(event.t) }}
          </span>
        </div>

        <button
          type="button"
          class="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors"
          aria-label="Bezárás"
          data-testid="inspector-close"
          @click="close"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <!-- Overview grid -->
        <div class="grid grid-cols-2 gap-3 p-3.5 rounded-lg bg-surface-2/60 border border-border-subtle text-xs">
          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Esemény típusa</div>
            <div class="font-medium text-text-primary mt-0.5">{{ event.type }}</div>
          </div>

          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Eszköz / Művelet</div>
            <div class="font-mono text-text-secondary mt-0.5 truncate">
              {{ (event as any).tool || (event as any).action || 'cmms-api' }}
            </div>
          </div>

          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Időpont</div>
            <div class="font-mono text-text-secondary mt-0.5">{{ fmtFullTime(event.t) }}</div>
          </div>

          <div>
            <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Azonosító</div>
            <div class="font-mono text-text-secondary mt-0.5 truncate">
              {{ (event as any).id || 'N/A' }}
            </div>
          </div>
        </div>

        <!-- Approval card -->
        <div v-if="event.type === 'approval'" class="space-y-2">
          <div class="text-[11px] font-mono uppercase tracking-wider text-text-muted font-semibold">
            Jóváhagyási kérelem
          </div>
          <ApprovalRequestCard
            :event="event as StreamApprovalEvent"
            @resolved="emit('approval-resolved', $event)"
          />
        </div>

        <!-- Question text -->
        <div v-if="(event as any).q" class="space-y-1.5">
          <div class="text-[11px] font-mono uppercase tracking-wider text-text-muted font-semibold">
            Feltett kérdés
          </div>
          <div class="p-3 rounded-lg bg-surface-2 border border-border-subtle text-[13px] text-text-primary leading-relaxed font-normal">
            {{ (event as any).q }}
          </div>
        </div>

        <!-- Summary / answer -->
        <div v-if="(event as any).summary" class="space-y-1.5">
          <div class="text-[11px] font-mono uppercase tracking-wider text-text-muted font-semibold">
            Összefoglaló / Válasz
          </div>
          <div class="p-3 rounded-lg bg-surface-2 border border-border-subtle text-[13px] text-text-primary leading-relaxed font-normal">
            {{ (event as any).summary }}
          </div>
        </div>

        <!-- Raw JSON payload -->
        <div class="space-y-2 pt-2 border-t border-border-subtle">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-mono uppercase tracking-wider text-text-muted font-semibold">
              Nyers adatfolyam (JSON)
            </span>
            <button
              type="button"
              class="h-6 px-2 text-[10.5px] font-mono rounded bg-surface-2 hover:bg-surface-2/80 border border-border-subtle text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1"
              @click="copyPayload"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
              {{ copied ? 'Másolva!' : 'Másolás' }}
            </button>
          </div>

          <div class="relative">
            <pre
              class="p-3.5 rounded-lg bg-canvas-2 border border-border-subtle font-mono text-[11.5px] text-text-secondary overflow-x-auto max-h-[300px] leading-relaxed"
            ><code>{{ sanitizedJson }}</code></pre>
          </div>
        </div>
      </div>
    </div>
  </ResponsiveDrawer>
</template>
