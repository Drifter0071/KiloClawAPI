<script setup lang="ts">
// src/components/TicketDetailsBody.vue
//
// Shared body for the two ticket inspector variants
// (`TicketPanel` and `TicketInspector`). Renders the full ticket
// details that come back from `useApi().getTicketBySorszam(s)`:
//
//   - Status pill (open / closed) + report date
//   - Kategoria, sulyossag, technician, problem_kategoria / alkategoria
//   - Customer (name, address, phone, email) — clickable phone/email
//   - Devices (raw + structured model / controller / machine_type)
//   - All notes in lifecycle order: reported → work → free, with
//     author + created_at per note
//
// Loading and error states are passed in by the parent — the parent
// owns the useQuery wrapper so it can keep the inspector stable
// across re-opens. We just render the resolved ticket.

import { computed } from 'vue'
import type { TicketDetails, TicketNote } from '@/lib/api'

const props = defineProps<{
  ticket: TicketDetails | null
  loading: boolean
  hasResolved: boolean
  /** Compact = the drawer/panel header. Full = the inspect-only view. */
  density?: 'compact' | 'full'
}>()

const density = computed(() => props.density ?? 'compact')

const statusLabel = computed(() => {
  const t = props.ticket
  if (!t) return '—'
  return t.status === 'open' ? 'Nyitott' : t.status === 'closed' ? 'Lezárt' : t.status
})

const statusTone = computed(() => {
  const t = props.ticket
  if (!t) return 'muted'
  return t.status === 'open'
    ? 'text-warning'
    : t.status === 'closed'
      ? 'text-success'
      : 'text-text-muted'
})

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}. ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtLongDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const months = [
    'január', 'február', 'március', 'április', 'május', 'június',
    'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
  ]
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}. ${months[d.getMonth()]} ${d.getDate()}. ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const reportedAt = computed(() => fmtLongDate(props.ticket?.reported_at_iso))

const kategoria = computed(() => {
  const t = props.ticket
  if (!t) return '—'
  return (
    t.problem_kategoria ||
    t.kategoria_inferred ||
    '—'
  )
})

const sulyossag = computed(() => {
  const t = props.ticket
  if (!t) return '—'
  return t.sulyossag_inferred || t.sulyossag || '—'
})

const technician = computed(() => props.ticket?.technician || '—')

// Notes are pre-sorted: reported first, then work in time order, then
// free. The server already returns them in lifecycle order, but we
// bucket them by kind for the section render so the inspector shows
// clear "Bejelentés" / "Munkák" / "Egyéb megjegyzések" groups.
const reportedNotes = computed<TicketNote[]>(() =>
  (props.ticket?.notes ?? []).filter((n) => n.kind === 'reported'),
)
const workNotes = computed<TicketNote[]>(() =>
  (props.ticket?.notes ?? []).filter((n) => n.kind === 'work'),
)
const freeNotes = computed<TicketNote[]>(() =>
  (props.ticket?.notes ?? []).filter((n) => n.kind === 'free'),
)

function noteKindLabel(kind: TicketNote['kind']): string {
  if (kind === 'reported') return 'Bejelentés'
  if (kind === 'work') return 'Munka'
  return 'Megjegyzés'
}

function noteKindTone(kind: TicketNote['kind']): string {
  if (kind === 'reported') return 'text-accent border-accent/30 bg-accent/[0.06]'
  if (kind === 'work') return 'text-success border-success/30 bg-success/[0.06]'
  return 'text-text-secondary border-border-subtle bg-surface'
}

const customer = computed(() => props.ticket?.customer ?? null)
const devices = computed(() => props.ticket?.devices ?? [])
</script>

<template>
  <!-- Loading skeleton. Mirrors the layout of the real body so the
       inspector doesn't jump when data lands. -->
  <div
    v-if="loading && !hasResolved"
    class="space-y-4"
    data-testid="ticket-details-loading"
  >
    <div class="grid grid-cols-2 gap-3">
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Bejelentve</div>
        <div class="mt-1 h-3.5 w-28 rounded bg-surface-2 animate-pulse" />
      </div>
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Státusz</div>
        <div class="mt-1 h-3.5 w-16 rounded bg-surface-2 animate-pulse" />
      </div>
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Kategória</div>
        <div class="mt-1 h-3.5 w-24 rounded bg-surface-2 animate-pulse" />
      </div>
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Súlyosság</div>
        <div class="mt-1 h-3.5 w-20 rounded bg-surface-2 animate-pulse" />
      </div>
    </div>
    <div>
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">Ügyfél</div>
      <div class="h-3.5 w-40 rounded bg-surface-2 animate-pulse" />
      <div class="mt-1 h-3.5 w-32 rounded bg-surface-2 animate-pulse" />
    </div>
    <div>
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">Leírás</div>
      <div class="h-3.5 w-full rounded bg-surface-2 animate-pulse" />
      <div class="mt-1 h-3.5 w-3/4 rounded bg-surface-2 animate-pulse" />
    </div>
  </div>

  <!-- Resolved ticket. -->
  <div
    v-else-if="ticket"
    class="space-y-4"
    data-testid="ticket-details"
  >
    <!-- Status + report date + classification -->
    <div class="grid grid-cols-2 gap-3" data-testid="ticket-details-meta">
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Bejelentve</div>
        <div
          class="mt-1 font-mono text-[13px] text-text-primary tabular-nums"
          data-testid="ticket-details-reported-at"
        >
          {{ reportedAt }}
        </div>
      </div>
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Státusz</div>
        <div
          class="mt-1 font-mono text-[13px] tabular-nums"
          :class="statusTone"
          data-testid="ticket-details-status"
        >
          {{ statusLabel }}
        </div>
      </div>
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Kategória</div>
        <div
          class="mt-1 text-[13px] text-text-primary"
          data-testid="ticket-details-kategoria"
        >{{ kategoria }}</div>
      </div>
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Súlyosság</div>
        <div
          class="mt-1 text-[13px] text-text-primary"
          data-testid="ticket-details-sulyossag"
        >{{ sulyossag }}</div>
      </div>
      <div v-if="technician !== '—'">
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Szerelő</div>
        <div
          class="mt-1 text-[13px] text-text-primary"
          data-testid="ticket-details-technician"
        >{{ technician }}</div>
      </div>
      <div v-if="ticket.problem_alkategoria">
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Alkategória</div>
        <div class="mt-1 text-[13px] text-text-primary">{{ ticket.problem_alkategoria }}</div>
      </div>
    </div>

    <!-- Customer card -->
    <div
      v-if="customer && customer.name"
      class="rounded-lg border border-border-subtle bg-surface px-3.5 py-3"
      data-testid="ticket-details-customer"
    >
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
        Ügyfél
      </div>
      <div class="text-[14px] font-semibold text-text-primary leading-snug">
        {{ customer.name }}
      </div>
      <div
        v-if="customer.address || customer.zip"
        class="mt-1 text-[12px] text-text-secondary"
      >
        <span v-if="customer.zip">{{ customer.zip }}</span>
        <span v-if="customer.address"> {{ customer.address }}</span>
      </div>
      <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        <a
          v-if="customer.phone"
          :href="`tel:${customer.phone}`"
          class="font-mono tabular-nums text-accent hover:text-accent-hover transition-colors duration-150"
          data-testid="ticket-details-phone"
        >{{ customer.phone }}</a>
        <a
          v-if="customer.email"
          :href="`mailto:${customer.email}`"
          class="text-accent hover:text-accent-hover transition-colors duration-150 break-all"
          data-testid="ticket-details-email"
        >{{ customer.email }}</a>
      </div>
    </div>

    <!-- Devices list -->
    <div
      v-if="devices.length > 0"
      data-testid="ticket-details-devices"
    >
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
        Gépek ({{ devices.length }})
      </div>
      <ul class="space-y-1.5">
        <li
          v-for="(d, i) in devices"
          :key="i"
          class="rounded-md border border-border-subtle bg-surface px-3 py-2"
          :data-testid="`ticket-details-device-${i}`"
        >
          <div class="font-mono text-[12px] text-text-primary break-all">
            {{ d.raw || '—' }}
          </div>
          <div
            v-if="d.model || d.controller || d.machine_type"
            class="mt-0.5 text-[11px] text-text-muted flex flex-wrap gap-x-2"
          >
            <span v-if="d.model">modell: <span class="text-text-secondary">{{ d.model }}</span></span>
            <span v-if="d.controller">vezérlő: <span class="text-text-secondary">{{ d.controller }}</span></span>
            <span v-if="d.machine_type">típus: <span class="text-text-secondary">{{ d.machine_type }}</span></span>
          </div>
        </li>
      </ul>
    </div>

    <!-- Notes: bucketed reported / work / free, most recent first. -->
    <div data-testid="ticket-details-notes">
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
        Bejegyzések ({{ (ticket.notes ?? []).length }})
      </div>
      <ol class="space-y-2.5">
        <li
          v-for="(n, i) in [
            ...reportedNotes,
            ...[...workNotes].reverse(),
            ...[...freeNotes].reverse(),
          ]"
          :key="`${n.kind}-${i}-${n.created_at ?? ''}`"
          class="rounded-lg border px-3.5 py-2.5"
          :class="noteKindTone(n.kind)"
          :data-testid="`ticket-details-note-${i}`"
        >
          <div class="flex items-baseline justify-between gap-2 mb-1">
            <span
              class="text-[10px] font-mono uppercase tracking-wider font-semibold"
              :class="noteKindTone(n.kind).split(' ').filter(c => c.startsWith('text-')).join(' ')"
            >{{ noteKindLabel(n.kind) }}</span>
            <span
              v-if="n.created_at"
              class="font-mono text-[10px] text-text-muted tabular-nums"
            >{{ fmtDate(n.created_at) }}</span>
          </div>
          <p class="text-[13px] text-text-primary leading-relaxed whitespace-pre-wrap break-words">
            {{ n.body }}
          </p>
          <div
            v-if="n.author"
            class="mt-1 text-[10px] font-mono text-text-muted"
          >— {{ n.author }}</div>
        </li>
      </ol>
    </div>
  </div>

  <!-- Resolved query returned null. -->
  <div
    v-else
    class="rounded-md border border-border-subtle bg-surface px-3 py-2.5 text-[12px] text-text-muted"
    data-testid="ticket-details-empty"
  >
    Nem található részletes adat ehhez a sorszámhoz. Próbáld a
    "Megnyitás Ask-ban" gombot, vagy frissítsd az oldalt.
  </div>
</template>
