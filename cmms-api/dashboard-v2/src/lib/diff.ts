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
