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
import { parseCustomerContacts, type CustomerContact } from '@/lib/customerContacts'
import Skeleton from '@/components/Skeleton.vue'

/**
 * Build a `tel:` href from a raw phone string.
 *
 * The cmms.db data mixes formats:
 *   - "30-4034262"  (Hungarian mobile, dash-separated)
 *   - "52 582 721"  (spaces)
 *   - "+36 30 403 4262"  (international)
 *   - "(06-1) 555-0123"  (parens)
 *
 * RFC 3966 says `tel:` URIs accept digits, `-`, `.`, `(`, `)`, `+`,
 * spaces; everything else is ignored. We strip the rest to maximize
 * dialer compatibility (Android dialer, iOS dialer, desktop Skype
 * all accept the cleaned form). We DO keep the leading `+` and the
 * inner separators because some dialers need them to detect the
 * country code.
 */
function telHref(phone: string): string {
  // Keep only digits, spaces, dashes, dots, parens, leading +.
  // We also collapse repeated spaces to a single space.
  const cleaned = phone
    .replace(/[^\d+\-.() ]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
  return `tel:${cleaned}`
}

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

/**
 * The phone that the primary "Hívás" button dials. The parser puts
 * the "Fő:" main line FIRST when present, so we just take index 0.
 * If the parser came up empty but `customer.phone` itself is set
 * (some legacy rows are a single phone with no `;`), fall back to
 * that. Returns null when no phone is available at all.
 */
const primaryPhone = computed<CustomerContact | null>(() => {
  if (parsedContacts.value.phones.length > 0) {
    return parsedContacts.value.phones[0]!
  }
  const raw = customer.value?.phone?.trim()
  if (raw) return { name: null, value: raw }
  return null
})

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
  <!-- Loading skeleton (Phase 8, 2026-08-24). Mirrors the layout of
       the real body so the inspector doesn't jump when data lands,
       and uses the shared <Skeleton> component (shimmer animation)
       for a consistent "preparing" feel. -->
  <div
    v-if="loading && !hasResolved"
    class="space-y-4"
    data-testid="ticket-details-loading"
  >
    <div class="grid grid-cols-2 gap-3">
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Bejelentve</div>
        <Skeleton h="h-3.5" w="w-28" class="mt-1" />
      </div>
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Státusz</div>
        <Skeleton h="h-3.5" w="w-16" class="mt-1" />
      </div>
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Kategória</div>
        <Skeleton h="h-3.5" w="w-24" class="mt-1" />
      </div>
      <div>
        <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted">Súlyosság</div>
        <Skeleton h="h-3.5" w="w-20" class="mt-1" />
      </div>
    </div>
    <div>
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">Ügyfél</div>
      <Skeleton h="h-3.5" w="w-40" />
      <div class="mt-1.5">
        <Skeleton h="h-3.5" w="w-32" />
      </div>
    </div>
    <div>
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">Leírás</div>
      <Skeleton h="h-3.5" w="w-full" />
      <div class="mt-1.5">
        <Skeleton h="h-3.5" w="w-3/4" />
      </div>
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
      <!-- One-tap call button (Phase 8, 2026-08-24 — B9 in the brainstorm).
           Renders a large, high-contrast call button next to the
           primary contact. On mobile this opens the system dialer with
           the number pre-filled; on desktop it opens Skype/Teams/etc.
           We pick the FIRST contact (which the parser sets as the
           "Fő:" main line, falling back to the first named contact).
           If no phone was parsed, we fall back to the raw `customer.phone`
           field, then hide the button entirely. -->
      <div
        v-if="primaryPhone"
        class="mt-2.5 flex flex-wrap items-center gap-2"
        data-testid="ticket-details-call-row"
      >
        <a
          :href="telHref(primaryPhone.value)"
          class="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md
                 bg-success text-white font-semibold text-[13px]
                 hover:bg-success/90 active:scale-[0.98]
                 transition-all duration-150
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-success/50
                 shadow-sm shadow-black/20"
          :aria-label="`Hívás: ${primaryPhone.name ?? 'fő'} ${primaryPhone.value}`"
          data-testid="ticket-details-call-button"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M3.5 2.5a1 1 0 0 1 1-1h2.6a1 1 0 0 1 .98.8l.7 3.1a1 1 0 0 1-.27.93L7 7.8a9 9 0 0 0 4.2 4.2l1.5-1.5a1 1 0 0 1 .93-.27l3.1.7a1 1 0 0 1 .8.98v2.6a1 1 0 0 1-1 1h-1A12 12 0 0 1 3.5 3.5v-1z"
              fill="currentColor"
            />
          </svg>
          <span>Hívás</span>
          <span class="font-mono tabular-nums opacity-90 text-[12px]">
            {{ primaryPhone.value }}
          </span>
        </a>
        <span
          v-if="primaryPhone.name"
          class="text-[12px] text-text-secondary truncate"
          data-testid="ticket-details-call-name"
        >
          {{ primaryPhone.name }}
        </span>
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
