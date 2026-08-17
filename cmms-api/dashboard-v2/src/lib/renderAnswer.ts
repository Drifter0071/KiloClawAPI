// src/lib/renderAnswer.ts
//
// Tiszta TypeScript leképező réteg az Ask oldalhoz. A wire `AnswerResponse`
// (docs/.../2026-08-12--cmms-dashboard-v2-redesign.md §2.1) típust átalakítja
// egy típusos UI modellre, amit az AskPage template renderel. NINCS benne Vue
// import, NINCS reaktivitás — ez egy determinisztikus adat-leképező,
// vitest-tel tesztelve.
//
// Szabályok, amikre az oldal támaszkodik:
//   - mode === 'confirm' → a törzset a "Azt hiszem, X-re gondoltál — jó?"
//     kérdés váltja fel (a nyertes candidate summary).
//   - bizonytalanság-pill: >=0.60 smaragd 'magas', 0.40–0.59 borostyán 'közepes',
//     <0.40 rózsa 'alacsony' (forrás: cmms-api/src/lib/score.ts:75).
//   - candidates[].family a szekció címe az "Egyéb értelmezések" expanderben.
//   - Soha nincs nyers JSON — az eredmények címkézett sorokká normalizálódnak;
//     ami nem nyerhető ki, '—' jelenik meg, soha nem JSON dump.

import type {
  AnswerCandidate,
  AnswerFilters,
  AnswerResponse,
  EvidenceTicket,
} from './api'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConfidenceLevel = 'high' | 'med' | 'low'

/** One normalized result row from `results: unknown[]`. */
export interface ResultRow {
  sorszam?: string
  /** Main human text — snippet/notes/name/model/customer, whichever hit first. */
  primary: string
  /** Secondary label — kategoria / status / type, if present. */
  secondary?: string
  /** Remaining scalar key/value pairs (max 4), for a compact detail line. */
  meta: Array<[string, string]>
}

/** One evidence ticket inside a group. */
export interface EvidenceRow {
  sorszam: string
  snippet: string
  kategoria: string | null
}

/** Evidence grouped by its `Record<string, EvidenceTicket[]>` key. */
export interface EvidenceGroup {
  label: string
  tickets: EvidenceRow[]
}

/** One row of the "Other interpretations" expander. */
export interface CandidateView {
  rank: number
  intent: string
  primitive: string
  /** score as a percentage string, e.g. "87%" (server score is 0..1). */
  scorePct: string
  family: string
  summary: string
}

/** The full typed view the Ask page renders from an AnswerResponse. */
export interface AnswerView {
  mode: 'answer' | 'confirm'
  q: string
  language: 'hu' | 'en'
  intent: string
  primitive: string
  summary: string
  rationale: string
  followUps: string[]
  confidence: number
  confidenceLabel: ConfidenceLevel
  threshold: number
  /** Emberi időablak címke: "2025-08-12 → 2026-08-12" vagy "Mind". */
  periodLabel: string
  total: number
  results: ResultRow[]
  evidence: EvidenceGroup[]
  candidates: CandidateView[]
  /** Winning candidate's summary when mode === 'confirm' (null otherwise). */
  confirmSummary: string | null
  /**
   * Winning candidate's filters when mode === 'confirm' — the Ask page
   * passes the known subset back to /v1/answer so "Yes, run it"
   * disambiguates the question server-side (answer.ts:63-71 overrides).
   */
  confirmFilters: AnswerFilters | null
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

const KNOWN_TEXT_KEYS = [
  // NOTE: 'sorszam' is intentionally absent — it has a dedicated field
  // on ResultRow. Primary text should be the human-readable content
  // (snippet/notes/name), not the ticket id.
  'snippet',
  'notes',
  'leiras',
  'summary',
  'text',
  'message',
  'problem',
  'name',
  'model',
  'customer',
  'device',
  'type',
] as const

const KNOWN_SECONDARY_KEYS = [
  'kategoria',
  'kategoria_inferred',
  'alkategoria',
  'sulyossag',
  'sulyossag_inferred',
  'status',
  'state',
] as const

const SCALAR = 'string'
const MAX_META_ROWS = 4
const MAX_META_VALUE_LEN = 120

/** Confidence pill cutoff, per spec §2.1. */
export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.6) return 'high'
  if (confidence >= 0.4) return 'med'
  return 'low'
}

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === SCALAR && (v as string).trim().length > 0) {
      return v as string
    }
    if (typeof v === 'number') {
      return String(v)
    }
  }
  return undefined
}

/** Normalize one `unknown` result row into a typed ResultRow. */
export function normalizeResultRow(raw: unknown, index: number): ResultRow {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { primary: '—', meta: [] }
  }
  const row = raw as Record<string, unknown>

  const sorszamRaw = row['sorszam']
  const sorszam =
    typeof sorszamRaw === SCALAR && (sorszamRaw as string).trim().length > 0
      ? (sorszamRaw as string)
      : undefined

  const primary =
    firstString(row, KNOWN_TEXT_KEYS) ??
    (sorszam ? sorszam : `Row ${index + 1}`)
  const secondary = firstString(row, KNOWN_SECONDARY_KEYS)

  const usedKeys = new Set<string>([...KNOWN_TEXT_KEYS, ...KNOWN_SECONDARY_KEYS])
  if (sorszam) usedKeys.add('sorszam')

  const meta: Array<[string, string]> = []
  for (const [k, v] of Object.entries(row)) {
    if (usedKeys.has(k)) continue
    if (typeof v === SCALAR || typeof v === 'number' || typeof v === 'boolean') {
      const text = String(v)
      if (text.length === 0) continue
      meta.push([k, text.length > MAX_META_VALUE_LEN ? `${text.slice(0, MAX_META_VALUE_LEN)}…` : text])
      if (meta.length >= MAX_META_ROWS) break
    }
  }

  return {
    sorszam,
    primary,
    secondary: secondary ?? undefined,
    meta,
  }
}

/** Flatten `evidence: Record<string, EvidenceTicket[]>` into groups. */
export function flattenEvidence(evidence: Record<string, EvidenceTicket[]>): EvidenceGroup[] {
  const groups: EvidenceGroup[] = []
  for (const [label, tickets] of Object.entries(evidence)) {
    if (!Array.isArray(tickets) || tickets.length === 0) continue
    groups.push({
      label: label.length > 0 ? label : 'Idézett ticketek',
      tickets: tickets.map((t) => ({
        sorszam: t.sorszam,
        snippet: t.snippet,
        kategoria: t.kategoria,
      })),
    })
  }
  return groups
}

function periodLabel(period: AnswerResponse['period']): string {
  if (!period) return 'Mind'
  return `${period.date_from} → ${period.date_to}`
}

function toCandidateView(c: AnswerCandidate): CandidateView {
  return {
    rank: c.rank,
    intent: c.intent,
    primitive: c.primitive,
    scorePct: `${Math.round(Math.max(0, Math.min(1, c.score)) * 100)}%`,
    family: c.family,
    summary: c.summary,
  }
}

/** The single entry point — maps an AnswerResponse to the Ask page's view. */
export function renderAnswer(data: AnswerResponse): AnswerView {
  const winning = data.candidates[0] ?? null
  const confirmSummary = data.mode === 'confirm' && winning ? winning.summary : null
  const confirmFilters = data.mode === 'confirm' && winning ? winning.filters : null
  return {
    mode: data.mode,
    q: data.q,
    language: data.language,
    intent: data.intent,
    primitive: data.primitive,
    summary: data.summary_llm ?? data.summary,
    rationale: data.rationale,
    followUps: Array.isArray(data.follow_ups) ? data.follow_ups : [],
    confidence: data.confidence,
    confidenceLabel: confidenceLevel(data.confidence),
    threshold: data.threshold,
    periodLabel: periodLabel(data.period),
    total: data.total,
    results: Array.isArray(data.results)
      ? data.results.map((r, i) => normalizeResultRow(r, i))
      : [],
    evidence: flattenEvidence(data.evidence ?? {}),
    candidates: Array.isArray(data.candidates)
      ? data.candidates.map(toCandidateView)
      : [],
    confirmSummary,
    confirmFilters,
  }
}
