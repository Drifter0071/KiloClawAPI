<script setup lang="ts">
// src/components/TicketDetailsBody.vue
//
// Shared body for the two ticket inspector variants
// (`TicketPanel` and `TicketInspector`). Renders the full ticket
// details that come back from `useApi().getTicketBySorszam(s)`:
//
//   - Status pill (open / closed) + report date
//   - Kategoria, sulyossag, technician, problem_kategoria / alkategoria
//   - Notes (Bejegyzések) — the diagnostic content; the operator
//     triages a ticket by reading what was reported and what was
//     done, so this comes FIRST (above the customer card and the
//     device list)
//   - Customer (name, address, phone, email) — supporting context
//   - Devices (raw + structured model / controller / machine_type) —
//     collapsed by default when there are many (>3) to avoid the
//     inspector scrolling past 27 machine rows
//
// Loading and error states are passed in by the parent — the parent
// owns the useQuery wrapper so it can keep the inspector stable
// across re-opens. We just render the resolved ticket.

import { computed, ref } from 'vue'
import type { TicketDetails, TicketNote } from '@/lib/api'
import { parseCustomerContacts } from '@/lib/customerContacts'

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

// Parse the legacy phone/email blobs into discrete contacts. The
// cmms.db stores them as `;`-separated strings, which would render as
// a wall of text if shown raw. See src/lib/customerContacts.ts.
const parsedContacts = computed(() =>
  parseCustomerContacts(customer.value?.phone, customer.value?.email),
)

// Device list preview. When there are many devices (>=4), show only
// the first 3 + an "Összes (N)" expander. This keeps the inspector
// usable on tickets with 20+ machine rows. A ticket with 27 devices
// pushes the actually-useful work-done below the fold otherwise.
const DEVICE_PREVIEW_COUNT = 3
const devicesExpanded = ref(false)
const visibleDevices = computed(() => {
  if (devicesExpanded.value) return devices.value
  return devices.value.slice(0, DEVICE_PREVIEW_COUNT)
})
const devicesHiddenCount = computed(() =>
  Math.max(0, devices.value.length - DEVICE_PREVIEW_COUNT),
)
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

    <!-- Notes: bucketed reported / work / free, most recent first.
         Placed BEFORE both customer and devices because the work-done
         is the most important diagnostic content — the operator triages
         a ticket by reading the reported issue and what was done to
         fix it, NOT by reading who the customer is or which machines
         are involved. The customer card and machine list are context
         the operator can scroll down to when needed. -->
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

    <!-- Customer card. Placed AFTER notes because the customer
         contact info is supporting context, not the primary triage
         signal. The notes already mention the customer by name; the
         operator scrolls down here when they need to call / email. -->
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
      <!-- Parsed phones. The legacy cmms.db stores every contact's
           phone in a single `;`-separated string. We split it via
           parseCustomerContacts() and render each as its own row so
           the inspector doesn't dump a wall of text. -->
      <ul
        v-if="parsedContacts.phones.length > 0"
        class="mt-2 space-y-0.5 text-[12px]"
        data-testid="ticket-details-phones"
      >
        <li
          v-for="(c, i) in parsedContacts.phones"
          :key="`p-${i}-${c.value}`"
          class="flex items-baseline gap-2"
        >
          <span
            v-if="c.name"
            class="shrink-0 text-text-secondary truncate max-w-[8rem]"
            :title="c.name"
          >{{ c.name }}:</span>
          <span v-else class="shrink-0 text-text-muted uppercase tracking-wider text-[10px] font-mono">Fő:</span>
          <a
            :href="`tel:${c.value}`"
            class="font-mono tabular-nums text-accent hover:text-accent-hover transition-colors duration-150"
            :data-testid="i === 0 ? 'ticket-details-phone' : `ticket-details-phone-${i}`"
          >{{ c.value }}</a>
        </li>
      </ul>
      <!-- Parsed emails. Same split logic, separate list. -->
      <ul
        v-if="parsedContacts.emails.length > 0"
        class="mt-1.5 space-y-0.5 text-[12px]"
        data-testid="ticket-details-emails"
      >
        <li
          v-for="(c, i) in parsedContacts.emails"
          :key="`e-${i}-${c.value}`"
        >
          <a
            :href="`mailto:${c.value}`"
            class="text-accent hover:text-accent-hover transition-colors duration-150 break-all"
            :data-testid="i === 0 ? 'ticket-details-email' : `ticket-details-email-${i}`"
          >{{ c.value }}</a>
        </li>
      </ul>
      <!-- Fallback: if the parser couldn't extract anything, show the
           raw string verbatim so the operator doesn't lose data. The
           parser is best-effort and may fail on unusually formatted
           legacy data. -->
      <div
        v-if="parsedContacts.phones.length === 0 && parsedContacts.emails.length === 0 && (customer.phone || customer.email)"
        class="mt-1.5 space-y-0.5 text-[12px]"
        data-testid="ticket-details-contacts-fallback"
      >
        <a
          v-if="customer.phone"
          :href="`tel:${customer.phone}`"
          class="block font-mono tabular-nums text-accent hover:text-accent-hover transition-colors duration-150 break-all"
          data-testid="ticket-details-phone"
        >{{ customer.phone }}</a>
        <a
          v-if="customer.email"
          :href="`mailto:${customer.email}`"
          class="block text-accent hover:text-accent-hover transition-colors duration-150 break-all"
          data-testid="ticket-details-email"
        >{{ customer.email }}</a>
      </div>
    </div>

    <!-- Devices list. Collapsed by default when there are >=4 to keep
         the inspector usable on tickets with 20+ machine rows. A
         ticket with 27 devices pushes the actually-useful work-done
         below the fold otherwise, so we show the first 3 + a
         "Mutasd az összeset (N)" expander. -->
    <div
      v-if="devices.length > 0"
      data-testid="ticket-details-devices"
    >
      <div class="flex items-baseline justify-between mb-1.5">
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">
          Gépek ({{ devices.length }})
        </div>
        <button
          v-if="devicesHiddenCount > 0 && !devicesExpanded"
          type="button"
          class="text-[10px] font-mono text-accent hover:text-accent-hover transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
          :aria-label="`Mutasd az összes gépet (${devicesHiddenCount + DEVICE_PREVIEW_COUNT})`"
          data-testid="ticket-details-devices-expand"
          @click="devicesExpanded = true"
        >
          + {{ devicesHiddenCount }} további
        </button>
      </div>
      <ul class="space-y-1.5">
        <li
          v-for="(d, i) in visibleDevices"
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
      <button
        v-if="devicesExpanded && devicesHiddenCount > 0"
        type="button"
        class="mt-1.5 text-[10px] font-mono text-text-muted hover:text-text-secondary transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
        data-testid="ticket-details-devices-collapse"
        @click="devicesExpanded = false"
      >
        Csak az első {{ DEVICE_PREVIEW_COUNT }} mutatása
      </button>
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
