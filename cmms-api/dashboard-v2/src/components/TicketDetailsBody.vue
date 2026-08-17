<script setup lang="ts">
// src/components/TicketDetailsBody.vue
//
// Shared body for the two ticket inspector variants
// (`TicketPanel` and `TicketInspector`). Renders the full ticket
// details that come back from `useApi().getTicketBySorszam(s)`:
//
//   - Status pill (open / closed) + report date
//   - Kategoria, sulyossag, technician, problem_kategoria / alkategoria
//   - Bejegyzések (notes) — bucketed reported / work / free in
//     lifecycle order. The actual story of the ticket.
//   - Gépek (devices) — deduped by (model, controller) so a single
//     multi-controller machine doesn't render as 27 raw rows.
//   - Ügyfél (customer) — name, address, and a SPLIT contact list
//     where each phone / email is its own line. The CMMS often stores
//     multiple phone numbers and emails in one TELEFON / E-MAIL cell,
//     separated by ; or , — previously the inspector dumped the whole
//     blob into a single <a href="tel:..."> link, which broke tap-to-call
//     and made the panel unreadable (e.g. HAJDU AUTOTECHNIKA had
//     ~10 phone numbers + 9 emails in one string).
//
// Section order is the operator's priority:
//   meta  →  notes  →  devices  →  customer
// "What was the problem / what did we do" first; "who do we call
// if we have to dispatch again" last.
//
// Loading and error states are passed in by the parent — the parent
// owns the useQuery wrapper so it can keep the inspector stable
// across re-opens. We just render the resolved ticket.

import { computed, ref } from 'vue'
import type { TicketDetails, TicketDevice, TicketNote } from '@/lib/api'

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

// ---------------------------------------------------------------------------
// Contact splitter
// ---------------------------------------------------------------------------
//
// The CMMS source stores phone/email cells as semi-free text:
//   "52-582721; Sőrés Zoltán:30-4034262; Kemecsei Bence:30-2198114;
//    Mikle Zoltán:30-7288268; Hajnal Gábor:30-4512767; ..."
//   "roman.adam@hajduautort.hu; makszim.ferenc@hajduautort.hu; ..."
//
// We split on `;` first (primary separator), then on `,` inside any
// chunk that's not a clean phone (a Hungarian phone may legitimately
// contain `,` for formatting, so we only split on `,` when the chunk
// has no digits and no `@`). Each non-empty chunk is then classified
// as phone / email / text, with the person's name preserved when the
// cell uses the "Név:érték" convention.
//
// This is intentionally regex-light. A real parser would need a
// 200-line state machine; we want a robust-but-cheap 95%-case
// splitter. Anything the splitter doesn't recognise stays as
// `kind: 'text'` and renders as a dimmed span (not a link), so the
// operator can still read the line and copy it if they need to.

type ContactChunk = {
  kind: 'phone' | 'email' | 'text'
  /** The "value" used for the href (digits-only for phone, full addr for email). */
  value: string
  /** What we actually render. For "Név:30-4034262" the display is the full
   *  chunk but the link wraps just the phone portion. */
  display: string
  /** Person name, if the chunk matched the "Név:value" convention. */
  name?: string
}

const PHONE_RE = /^[+\d][\d\s()./-]{5,}$/

function classifyChunk(chunk: string): ContactChunk {
  const trimmed = chunk.trim()
  if (!trimmed) return { kind: 'text', value: '', display: '' }

  // Email?
  const at = trimmed.indexOf('@')
  if (at > 0 && at < trimmed.length - 1 && !trimmed.includes(' ')) {
    return { kind: 'email', value: trimmed, display: trimmed }
  }

  // "Név:érték" convention? Strip the name off.
  const colon = trimmed.indexOf(':')
  if (colon > 0 && colon < trimmed.length - 1) {
    const name = trimmed.slice(0, colon).trim()
    const rest = trimmed.slice(colon + 1).trim()
    if (PHONE_RE.test(rest.replace(/\s/g, ''))) {
      return {
        kind: 'phone',
        value: rest.replace(/[^\d+]/g, ''),
        display: `${name} · ${rest}`,
        name,
      }
    }
  }

  // Bare phone?
  if (PHONE_RE.test(trimmed.replace(/\s/g, ''))) {
    return {
      kind: 'phone',
      value: trimmed.replace(/[^\d+]/g, ''),
      display: trimmed,
    }
  }

  return { kind: 'text', value: trimmed, display: trimmed }
}

function splitContacts(raw: string | null): ContactChunk[] {
  if (!raw) return []
  // Primary separator is `;`. We also split on a `,` that's followed
  // by something that doesn't look like a digit sequence — i.e. a
  // comma in a person's name like "Makszim Ferenc, már nem dolgozik
  // ott" should NOT split, but a stray ", " between two phone numbers
  // SHOULD. Heuristic: split on `,` only when the next non-space
  // character is a digit OR an `@`.
  const out: ContactChunk[] = []
  const chunks = raw
    .split(/;/g)
    .flatMap((part) => {
      // Split "a, b, c" only when the comma is followed by digit or @.
      return part.split(/,\s*(?=[\d@])/g)
    })
  for (const c of chunks) {
    const classified = classifyChunk(c)
    if (classified.display) out.push(classified)
  }
  return out
}

const phoneChunks = computed<ContactChunk[]>(() =>
  splitContacts(props.ticket?.customer?.phone ?? null),
)
const emailChunks = computed<ContactChunk[]>(() =>
  splitContacts(props.ticket?.customer?.email ?? null),
)
// Split phone / email chunks by classification. Only `kind: 'phone'`
// chunks become tap-to-call `<a href="tel:...">` links; `kind: 'text'`
// chunks (e.g. a parenthetical note from the CMMS that doesn't look
// like a phone) land in the dimmed fallback block below.
const phoneLinkChunks = computed<ContactChunk[]>(() =>
  phoneChunks.value.filter((c) => c.kind === 'phone'),
)
const emailLinkChunks = computed<ContactChunk[]>(() =>
  emailChunks.value.filter((c) => c.kind === 'email'),
)
const textChunks = computed<ContactChunk[]>(() => [
  ...phoneChunks.value,
  ...emailChunks.value,
].filter((c) => c.kind === 'text'))
const hasMultipleContacts = computed(
  () => phoneChunks.value.length + emailChunks.value.length > 1,
)

// ---------------------------------------------------------------------------
// Device dedup
// ---------------------------------------------------------------------------
//
// A single multi-controller machine can produce 20-30 `devices[]`
// rows in the CMMS source — one per controller, servo, accessory, etc.
// They are NOT 27 separate machines; they are 27 facets of one machine.
// The operator's question is "what machine is this ticket about?",
// not "list every named component".
//
// We group by (model, controller) and keep a single representative
// row, plus a count badge. The first row of each group is shown;
// the rest are accessible via the "Összes megjelenítése" disclosure
// so the operator can still find the rare case where two distinct
// machines were accidentally recorded on one ticket.

type DeviceGroup = {
  /** The representative device (first occurrence). */
  primary: TicketDevice
  count: number
  /** All devices in this group, including the primary. */
  members: TicketDevice[]
  /** Stable key used for v-for. */
  key: string
}

const groupedDevices = computed<DeviceGroup[]>(() => {
  const groups: DeviceGroup[] = []
  const index = new Map<string, DeviceGroup>()
  for (const d of devices.value) {
    const key = `${d.model ?? ''}||${d.controller ?? ''}||${d.machine_type ?? ''}`
    let g = index.get(key)
    if (!g) {
      g = { primary: d, count: 0, members: [], key }
      index.set(key, g)
      groups.push(g)
    }
    g.members.push(d)
    g.count++
  }
  return groups
})

const collapsedCount = computed(() => {
  // Total raw devices - number of visible groups = how many are hidden
  // behind the disclosure.
  return devices.value.length - groupedDevices.value.length
})

// Local UI state for the "Összes megjelenítése" disclosure.
// True → all raw `devices[]` rows are shown (no dedup).
// False → only the deduped groups are shown, with a count badge.
const showRawDevices = ref(false)
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
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">Bejegyzések</div>
      <div class="h-3.5 w-full rounded bg-surface-2 animate-pulse" />
      <div class="mt-1 h-3.5 w-3/4 rounded bg-surface-2 animate-pulse" />
      <div class="mt-1 h-3.5 w-2/3 rounded bg-surface-2 animate-pulse" />
    </div>
    <div>
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">Ügyfél</div>
      <div class="h-3.5 w-40 rounded bg-surface-2 animate-pulse" />
      <div class="mt-1 h-3.5 w-32 rounded bg-surface-2 animate-pulse" />
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

    <!-- Devices list, deduped by (model, controller, machine_type).
         The CMMS often stores one row per accessory / controller on
         a single machine, so 20-30 raw rows is normal for one ticket.
         We collapse to one row per logical machine, with a count
         badge for duplicates, and a disclosure to reveal all raw
         rows if the operator needs to dig deeper. -->
    <div
      v-if="devices.length > 0"
      data-testid="ticket-details-devices"
    >
      <div class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
        <span>Gépek</span>
        <span class="text-text-secondary">({{ groupedDevices.length }}<span v-if="collapsedCount > 0"> · {{ collapsedCount }} rejtett</span>)</span>
      </div>
      <ul class="space-y-1.5">
        <li
          v-for="(g, i) in groupedDevices"
          :key="g.key"
          class="rounded-md border border-border-subtle bg-surface px-3 py-2"
          :data-testid="`ticket-details-device-${i}`"
        >
          <div class="flex items-baseline gap-2">
            <span class="font-mono text-[12px] text-text-primary break-all">
              {{ g.primary.raw || '—' }}
            </span>
            <span
              v-if="g.count > 1"
              class="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider bg-nct-500/10 text-nct-soft border border-nct-soft/30"
              :data-testid="`ticket-details-device-count-${i}`"
            >×{{ g.count }}</span>
          </div>
          <div
            v-if="g.primary.model || g.primary.controller || g.primary.machine_type"
            class="mt-0.5 text-[11px] text-text-muted flex flex-wrap gap-x-2"
          >
            <span v-if="g.primary.model">modell: <span class="text-text-secondary">{{ g.primary.model }}</span></span>
            <span v-if="g.primary.controller">vezérlő: <span class="text-text-secondary">{{ g.primary.controller }}</span></span>
            <span v-if="g.primary.machine_type">típus: <span class="text-text-secondary">{{ g.primary.machine_type }}</span></span>
          </div>
        </li>
      </ul>
      <button
        v-if="collapsedCount > 0"
        type="button"
        class="mt-1.5 text-[11px] font-mono text-nct-soft hover:text-nct-500 focus:outline-none focus-visible:underline"
        :data-testid="`ticket-details-devices-show-all`"
        @click="showRawDevices = !showRawDevices"
      >
        {{
          showRawDevices
            ? 'Kevesebb mutatása'
            : `Összes megjelenítése (${devices.length} db)`
        }}
      </button>
      <ul
        v-if="showRawDevices"
        class="mt-1.5 space-y-1 border-t border-border-subtle pt-2"
        data-testid="ticket-details-devices-raw"
      >
        <li
          v-for="(d, i) in devices"
          :key="`raw-${i}`"
          class="font-mono text-[11px] text-text-muted break-all"
          :data-testid="`ticket-details-device-raw-${i}`"
        >
          {{ d.raw || '—' }}
        </li>
      </ul>
    </div>

    <!-- Customer card. The phone / email cells from the CMMS are
         semi-free text (one cell can hold 5-10 phone numbers and
         another 5-10 emails, separated by ; or ,). We split on those
         separators and render each contact as its own tappable line
         so tel: / mailto: work per-row instead of as one giant href. -->
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

      <!-- Phones -->
      <div
        v-if="phoneLinkChunks.length > 0"
        class="mt-2 space-y-0.5"
        data-testid="ticket-details-phones"
      >
        <a
          v-for="(c, i) in phoneLinkChunks"
          :key="`p-${i}`"
          :href="`tel:${c.value}`"
          class="flex items-center gap-1.5 text-[12px] font-mono tabular-nums text-accent hover:text-accent-hover transition-colors duration-150"
          :data-testid="
            i === 0 ? 'ticket-details-phone' : `ticket-details-contact-${i}`
          "
        >
          <svg
            class="w-3 h-3 shrink-0 text-text-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
          </svg>
          <span class="truncate">{{ c.display }}</span>
        </a>
      </div>

      <!-- Emails -->
      <div
        v-if="emailLinkChunks.length > 0"
        class="mt-1.5 space-y-0.5"
        data-testid="ticket-details-emails"
      >
        <a
          v-for="(c, i) in emailLinkChunks"
          :key="`e-${i}`"
          :href="`mailto:${c.value}`"
          class="flex items-center gap-1.5 text-[12px] text-accent hover:text-accent-hover transition-colors duration-150"
          :data-testid="
            i === 0 ? 'ticket-details-email' : `ticket-details-email-${i}`
          "
        >
          <svg
            class="w-3 h-3 shrink-0 text-text-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m22 7-10 5L2 7" />
          </svg>
          <span class="truncate">{{ c.display }}</span>
        </a>
      </div>

      <!-- Fallback: any text chunks we couldn't classify (e.g. notes
           like "(Makszim Ferenc - már nem dolgozik ott)") render as
           a dimmed line so the operator can still read them but
           tap-to-call never fires on garbage. -->
      <div
        v-if="textChunks.length > 0"
        class="mt-1.5 text-[11px] text-text-muted leading-snug"
        data-testid="ticket-details-contact-notes"
      >
        <span
          v-for="(c, i) in textChunks"
          :key="`t-${i}`"
        >{{ c.display }}<br v-if="i < textChunks.length - 1" /></span>
      </div>
    </div>
  </div>

  <!-- Resolved query returned null. -->
  <div
    v-else
    class="rounded-md border border-border-subtle bg-surface px-3 py-2.5 text-[12px] text-text-muted"
    data-testid="ticket-details-empty"
  >
    Nem található részletes adat ehhez a sorszámhoz. Frissítsd az
    oldalt, vagy zárd be a panelt és próbáld újra.
  </div>
</template>
