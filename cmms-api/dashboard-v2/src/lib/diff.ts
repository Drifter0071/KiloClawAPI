// src/lib/diff.ts
//
// Timezone helpers for the Diff page's "Since" picker (spec §5.4).
//
// Documented caveat (kept in one place per the spec): the operator's
// browser and the cmms-api server are both in Hungary (CET/CEST) today.
// The client converts the local `datetime-local` value to a UTC ISO
// string via `new Date(pickerValue + ":00Z")` — an explicit UTC parse,
// NOT `new Date(pickerValue)` (which would be interpreted in the
// browser's local zone and shift the window). Preset chips compute
// `now` from the client clock and submit the same way. If the operator
// ever travels and the client timezone disagrees with the server's,
// this module is the single place to fix.

import type { DiffChange } from './api'

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type DiffPreset = '1h' | '24h' | '7d' | '30d' | 'all'

export const DIFF_PRESETS: ReadonlyArray<{ value: DiffPreset; label: string }> = [
  { value: '1h', label: '1 ó' },
  { value: '24h', label: '24 ó' },
  { value: '7d', label: '7 n' },
  { value: '30d', label: '30 n' },
  { value: 'all', label: 'Mind' },
]

/**
 * Epoch ISO string used for the "All" preset. The server computes
 * `Date.parse(since) || 0` — parsing this yields 0, so the filter
 * includes every audit entry. (`since=''` would fall back to the
 * server's 1h default, so we must send an explicit value.)
 */
export const ALL_TIME_ISO = '1970-01-01T00:00:00.000Z'

const DURATION_MS: Record<Exclude<DiffPreset, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
}

/**
 * `datetime-local` value (e.g. "2026-08-12T14:30") → UTC ISO string.
 * Uses the explicit UTC parse from the spec: appends ":00Z".
 */
export function pickerValueToIso(pickerValue: string): string {
  return new Date(`${pickerValue}:00Z`).toISOString()
}

/** UTC ISO string → `datetime-local` value (first 16 chars, no Z). */
export function isoToPickerValue(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 16)
}

/**
 * The `since` value for a preset, computed from `now` (client clock).
 * 'all' → ALL_TIME_ISO. Everything else → now - duration as UTC ISO.
 */
export function presetToIso(preset: DiffPreset, now: Date = new Date()): string {
  if (preset === 'all') return ALL_TIME_ISO
  return new Date(now.getTime() - DURATION_MS[preset]).toISOString()
}

/** Barátságos címke megjelenítéshez: pl. "utolsó óra" / "utolsó 24 óra". */
export function presetLabel(preset: DiffPreset): string {
  switch (preset) {
    case '1h':
      return 'utolsó óra'
    case '24h':
      return 'utolsó 24 óra'
    case '7d':
      return 'utolsó 7 nap'
    case '30d':
      return 'utolsó 30 nap'
    case 'all':
      return 'minden id'
  }
}

/** Operator-facing timezone label, suffixed on rendered timestamps so
 *  the user always knows which zone a "14:30" refers to. Defaults to
 *  "CET" because the cmms-api + operator both live in Hungary. */
export const DIFF_TIMEZONE_LABEL = 'CET'

/**
 * Format a Date / ISO string in Hungarian: "2026. 08. 12. 14:30".
 * Seconds are dropped — the diff view shows minute precision.
 */
export function formatHuDateTime(d: Date | string | number | null | undefined): string {
  if (d == null) return ''
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${y}. ${m}. ${day}. ${hh}:${mm}`
}

// ---------------------------------------------------------------------------
// Diff categorization (Phase 9 audit-workspace redesign)
//
// The /api/diff endpoint today returns rows with shape
//   { entity, id, action, t, before, after }
// where `action` is the audit action ("approval", "answer", ...). There
// is no explicit "added/modified/deleted" discriminator. We still
// bucket the rows into a small number of categories so the UI can
// show a meaningful summary.
//
// The mapping is *deterministic and conservative* — we never claim
// a row is "added" or "deleted" unless the underlying payload
// supports that claim. The /api/diff response is an audit log, not a
// structured state-delta, so most rows land in "other". A future
// payload that ships a `kind` discriminator (or `restorable: true`)
// can be honoured here without touching the call sites.
// ---------------------------------------------------------------------------

/** High-level diff category surfaced in the UI summary. */
export type DiffCategory = 'added' | 'modified' | 'deleted' | 'other'

/** Category metadata used by the summary chips + the result list. */
export interface DiffCategoryMeta {
  value: DiffCategory
  label: string
  description: string
}

export const DIFF_CATEGORIES: ReadonlyArray<DiffCategoryMeta> = [
  { value: 'added', label: 'Hozzáadva', description: 'Új elem a kiválasztott időszakban' },
  { value: 'modified', label: 'Módosítva', description: 'Meglévő elem megváltozott' },
  { value: 'deleted', label: 'Törölve', description: 'Korábbi elem törölve' },
  { value: 'other', label: 'Egyéb szerkezeti változás', description: 'Audit-esemény a naplóból' },
]

/**
 * Map a raw audit row to a DiffCategory. If a future server payload
 * ships an explicit `kind` discriminator we honour it first; the
 * fallback below is action-based and matches the audit taxonomy
 * already used elsewhere in the dashboard.
 */
export function categorizeChange(change: DiffChange): DiffCategory {
  const c = change as DiffChange & { kind?: string }
  if (
    c.kind === 'added' ||
    c.kind === 'modified' ||
    c.kind === 'deleted' ||
    c.kind === 'other'
  ) {
    return c.kind
  }

  const a = String(change.action ?? '').toLowerCase()
  if (a === 'revert_request' || a === 'revert') return 'modified'
  if (a === 'create' || a === 'register' || a === 'add') return 'added'
  if (a === 'delete' || a === 'remove') return 'deleted'

  return 'other'
}

/** Bucket a list of changes by DiffCategory (UI order). */
export function groupChangesByCategory(
  changes: ReadonlyArray<DiffChange>,
): Record<DiffCategory, DiffChange[]> {
  const out: Record<DiffCategory, DiffChange[]> = {
    added: [],
    modified: [],
    deleted: [],
    other: [],
  }
  for (const c of changes) out[categorizeChange(c)].push(c)
  return out
}

/** Cheaper than `groupChangesByCategory` if you only need the totals. */
export function countByCategory(
  changes: ReadonlyArray<DiffChange>,
): Record<DiffCategory, number> {
  const out: Record<DiffCategory, number> = { added: 0, modified: 0, deleted: 0, other: 0 }
  for (const c of changes) out[categorizeChange(c)] += 1
  return out
}

// ---------------------------------------------------------------------------
// Hungarian date / time helpers (used by the new Diff workspace)
//
// We extend the existing `formatHuDateTime` with a couple of
// presentation variants. All helpers accept a Date or an ISO string
// and render Hungarian-language output. We use the Hungarian long
// month names inline rather than relying on
// `toLocaleString('hu-HU', ...)` so unit tests are deterministic
// across Node / browser ICU versions.
// ---------------------------------------------------------------------------

const HU_MONTHS = [
  'január',
  'február',
  'március',
  'április',
  'május',
  'június',
  'július',
  'augusztus',
  'szeptember',
  'október',
  'november',
  'december',
]

function toDate(input: Date | string | number | null | undefined): Date | null {
  if (input === null || input === undefined) return null
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return null
  return d
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Long Hungarian date: "2026. augusztus 13." */
export function formatHuDate(input: Date | string | number | null | undefined): string {
  const d = toDate(input)
  if (!d) return '—'
  const y = d.getFullYear()
  const m = HU_MONTHS[d.getMonth()]!
  return `${y}. ${m} ${d.getDate()}.`
}

/** Monospace timestamp: "2026-08-12 14:30:22". Used by the row
 *  timestamp cell so audit accuracy is preserved. The wire is UTC,
 *  so we render the UTC components — the same convention the
 *  original `formatTimestamp()` used in the previous DiffPage. */
export function formatIsoMonospace(
  input: Date | string | number | null | undefined,
): string {
  const d = toDate(input)
  if (!d) return '—'
  const y = d.getUTCFullYear()
  const m = pad2(d.getUTCMonth() + 1)
  const day = pad2(d.getUTCDate())
  const hh = pad2(d.getUTCHours())
  const mm = pad2(d.getUTCMinutes())
  const ss = pad2(d.getUTCSeconds())
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`
}

/** Render a date+time with the timezone label: "2026. 08. 12. 14:30 CET". */
export function formatHuDateTimeWithZone(
  input: Date | string | number | null | undefined,
  zoneLabel: string = DIFF_TIMEZONE_LABEL,
): string {
  return `${formatHuDateTime(input)} ${zoneLabel}`
}

/**
 * Hungarian relative phrase: "2 perce", "3 órája", "4 napja".
 * Falls back to the absolute hu date+time when the diff is > 30
 * days so the audit row stays unambiguous.
 */
export function formatHuRelative(
  input: Date | string | number | null | undefined,
  now: Date = new Date(),
): string {
  const d = toDate(input)
  if (!d) return '—'
  const diffMs = now.getTime() - d.getTime()
  if (diffMs < 60_000) return 'most'
  if (diffMs < 3_600_000) {
    const m = Math.floor(diffMs / 60_000)
    return `${m} perce`
  }
  if (diffMs < 86_400_000) {
    const h = Math.floor(diffMs / 3_600_000)
    return `${h} órája`
  }
  if (diffMs < 2_592_000_000) {
    const days = Math.floor(diffMs / 86_400_000)
    return `${days} napja`
  }
  return formatHuDateTime(d)
}

// ---------------------------------------------------------------------------
// DiffChange presentation helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a change's `action` field. Falls back to
 *  the raw action string when no friendly label is known. */
export function actionLabel(action: string | null | undefined): string {
  const a = String(action ?? '').toLowerCase()
  switch (a) {
    case 'approval':
      return 'Jóváhagyás'
    case 'answer':
      return 'Válasz'
    case 'login':
      return 'Bejelentkezés'
    case 'logout':
      return 'Kijelentkezés'
    case 'login_failed':
      return 'Sikertelen bejelentkezés'
    case 'question':
      return 'Kérdés'
    case 'acquire_token':
      return 'Token kiadva'
    case 'token_rotate_request':
      return 'Token rotáció kérelem'
    case 'revert_request':
      return 'Visszaállítási kérelem'
    default:
      return action || 'Egyéb'
  }
}

/** Truncate a long string safely for one-line summaries. */
export function truncate(value: string | null | undefined, max = 140): string {
  if (!value) return ''
  if (value.length <= max) return value
  return `${value.slice(0, max - 1).trimEnd()}…`
}

/** Stringify an unknown payload for the raw-data section. Never throws
 *  — falls back to `String(v)` if JSON.stringify fails (e.g. on a
 *  circular structure). */
export function safeStringify(value: unknown, max = 4_000): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return truncate(value, max)
  try {
    const s = JSON.stringify(value, null, 2)
    return truncate(s, max)
  } catch {
    return truncate(String(value), max)
  }
}

