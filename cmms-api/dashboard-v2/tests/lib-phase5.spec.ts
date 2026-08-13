// tests/lib-phase5.spec.ts
//
// Phase 5 — pure-lib tests (no DOM needed):
//   - src/lib/renderAnswer.ts   (answer → typed UI view)
//   - src/lib/diff.ts           (since-picker timezone helpers)
//   - src/lib/errors.ts         (error → human sentence)
//   - src/lib/cytoscape.ts      (bucket/color/size rules — pure fns only;
//                                makeCyto needs a DOM, covered via MapPage)
//
// Run: cd cmms-api/dashboard-v2 && bun run test (vitest)

import { describe, expect, it } from 'vitest'

import { confidenceLevel, renderAnswer } from '../src/lib/renderAnswer'
import type { AnswerResponse } from '../src/lib/api'
import {
  ALL_TIME_ISO,
  pickerValueToIso,
  presetToIso,
  isoToPickerValue,
  presetLabel,
} from '../src/lib/diff'
import { humanizeError } from '../src/lib/errors'
import { bucketForTickets, nodeSize, NODE_COLORS } from '../src/lib/cytoscape'

// ---------------------------------------------------------------------------
// renderAnswer
// ---------------------------------------------------------------------------

function sampleAnswer(overrides: Partial<AnswerResponse> = {}): AnswerResponse {
  return {
    q: 'M26057 vezérlés',
    language: 'hu',
    intent: 'find_ticket',
    primitive: 'search_tickets',
    group_by: null,
    filters: {},
    period: null,
    summary: '1 ticket található',
    follow_ups: ['Show me the customer', 'Top ügyfelek tavaly'],
    results: [{ sorszam: 'M-2026/0123', snippet: 'Vezérlő hiba, PLC', kategoria: 'Szoftver hiba' }],
    evidence: {
      'M-2026/0123': [
        {
          sorszam: 'M-2026/0123',
          key: 'a',
          reported_at_iso: '2026-08-01T10:00:00Z',
          snippet: 'Vezérlő hiba, PLC',
          kategoria: 'Szoftver hiba',
          kategoria_inferred: null,
          sulyossag_inferred: 'kozepes',
        },
      ],
    },
    total: 1,
    rationale: 'keyword match',
    mode: 'answer',
    confidence: 0.92,
    threshold: 0.6,
    candidates: [
      {
        rank: 1,
        intent: 'find_ticket',
        primitive: 'search_tickets',
        score: 0.92,
        score_breakdown: {},
        family: 'other',
        filters: {},
        period: null,
        summary: '1 ticket található',
        follow_ups: [],
        results: [],
        evidence: {},
        total: 1,
        rationale: '',
      },
      {
        rank: 2,
        intent: 'customer_stats',
        primitive: 'get_ticket_stats',
        score: 0.41,
        score_breakdown: {},
        family: 'customer',
        filters: {},
        period: null,
        summary: 'Ügyfél statisztika',
        follow_ups: [],
        results: [],
        evidence: {},
        total: 0,
        rationale: '',
      },
    ],
    mode_rationale: '',
    ...overrides,
  }
}

describe('renderAnswer', () => {
  it('maps an answer-mode response into a typed view', () => {
    const view = renderAnswer(sampleAnswer())
    expect(view.mode).toBe('answer')
    expect(view.confidenceLabel).toBe('high')
    expect(view.periodLabel).toBe('Mind')
    expect(view.results).toHaveLength(1)
    expect(view.results[0]?.sorszam).toBe('M-2026/0123')
    expect(view.results[0]?.primary).toBe('Vezérlő hiba, PLC')
    expect(view.results[0]?.secondary).toBe('Szoftver hiba')
    expect(view.evidence).toHaveLength(1)
    expect(view.evidence[0]?.tickets[0]?.sorszam).toBe('M-2026/0123')
    expect(view.followUps).toHaveLength(2)
    expect(view.candidates).toHaveLength(2)
    expect(view.candidates[1]?.scorePct).toBe('41%')
    expect(view.candidates[1]?.family).toBe('customer')
    expect(view.confirmSummary).toBeNull()
  })

  it('sets confirmSummary from the winning candidate in confirm mode', () => {
    const view = renderAnswer(sampleAnswer({ mode: 'confirm', confidence: 0.38 }))
    expect(view.mode).toBe('confirm')
    expect(view.confirmSummary).toBe('1 ticket található')
    expect(view.confidenceLabel).toBe('low')
  })

  it('handles malformed rows without raw JSON', () => {
    const view = renderAnswer(
      sampleAnswer({ results: [null, 'plain string', { count: 3, sulyossag: 'kritikus' }] }),
    )
    expect(view.results[0]?.primary).toBe('—')
    expect(view.results[1]?.primary).toBe('—')
    // numeric-only row: count is not a text key, falls back to Row N
    expect(view.results[2]?.primary).toBe('Row 3')
    expect(view.results[2]?.secondary).toBe('kritikus')
    expect(view.results[2]?.meta).toEqual([['count', '3']])
  })

  it('renders a period label when period is present', () => {
    const view = renderAnswer(
      sampleAnswer({
        period: {
          token: 'last_year',
          resolved_token: 'last_year',
          date_from: '2025-08-12',
          date_to: '2026-08-12',
          label_en: 'last year',
          label_hu: 'tavaly',
        },
      }),
    )
    expect(view.periodLabel).toBe('2025-08-12 → 2026-08-12')
  })

  it('confidenceLevel implements the spec cutoffs', () => {
    expect(confidenceLevel(0.6)).toBe('high')
    expect(confidenceLevel(0.999)).toBe('high')
    expect(confidenceLevel(0.59)).toBe('med')
    expect(confidenceLevel(0.4)).toBe('med')
    expect(confidenceLevel(0.39)).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// diff.ts
// ---------------------------------------------------------------------------

describe('diff.ts', () => {
  it('pickerValueToIso uses the explicit UTC parse (:00Z)', () => {
    // A local 14:30 in UTC+2 must NOT shift to 12:30 — we parse as UTC.
    const iso = pickerValueToIso('2026-08-12T14:30')
    expect(iso).toBe('2026-08-12T14:30:00.000Z')
  })

  it('isoToPickerValue round-trips', () => {
    expect(isoToPickerValue('2026-08-12T14:30:00.000Z')).toBe('2026-08-12T14:30')
    expect(isoToPickerValue('garbage')).toBe('')
  })

  it('presetToIso computes now - duration from the client clock', () => {
    const now = new Date('2026-08-12T12:00:00.000Z')
    expect(presetToIso('1h', now)).toBe('2026-08-12T11:00:00.000Z')
    expect(presetToIso('24h', now)).toBe('2026-08-11T12:00:00.000Z')
    expect(presetToIso('7d', now)).toBe('2026-08-05T12:00:00.000Z')
    expect(presetToIso('all', now)).toBe(ALL_TIME_ISO)
  })

  it('presetLabel is human-readable', () => {
    expect(presetLabel('24h')).toBe('utolsó 24 óra')
    expect(presetLabel('all')).toBe('minden id')
  })
})

// ---------------------------------------------------------------------------
// errors.ts
// ---------------------------------------------------------------------------

describe('humanizeError', () => {
  it('maps cmms-api unavailable to a human sentence with the server hint', () => {
    const { title, description } = humanizeError({
      status: 503,
      message: 'HTTP 503',
      body: {
        error: 'cmms-api unavailable',
        hint: 'cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.',
      },
    })
    expect(title).toBe('CMMS API nem elérhető')
    expect(description).toContain('Try again in a minute')
  })

  it('maps network failure (status 0)', () => {
    const { title } = humanizeError({ status: 0, message: 'Network error', body: undefined })
    expect(title).toBe('Kapcsolódási hiba')
  })

  it('maps generic 5xx and 4xx', () => {
    expect(humanizeError({ status: 500, message: 'HTTP 500', body: { detail: 'boom' } }).title).toBe(
      'Szerverhiba (HTTP 500)',
    )
    expect(
      humanizeError({ status: 404, message: 'HTTP 404', body: { error: 'not found' } }).title,
    ).toBe('A kérés elbukott (HTTP 404)')
  })

  it('degrades unknown errors gracefully', () => {
    expect(humanizeError(new Error('boom')).description).toBe('boom')
    expect(humanizeError('weird').title).toBe('Valami elromlott')
  })
})

// ---------------------------------------------------------------------------
// cytoscape.ts (pure rules)
// ---------------------------------------------------------------------------

describe('cytoscape node rules', () => {
  it('buckets tickets per spec thresholds', () => {
    expect(bucketForTickets(0)).toBe('low')
    expect(bucketForTickets(2)).toBe('low')
    expect(bucketForTickets(3)).toBe('mid')
    expect(bucketForTickets(9)).toBe('mid')
    expect(bucketForTickets(10)).toBe('high')
    expect(bucketForTickets(65_000)).toBe('high')
  })

  it('sizes nodes between 20 and 48px, monotonically', () => {
    expect(nodeSize(1)).toBeGreaterThanOrEqual(20)
    expect(nodeSize(1)).toBeLessThan(nodeSize(10))
    expect(nodeSize(10)).toBeLessThan(nodeSize(100))
    expect(nodeSize(10_000_000)).toBe(48)
  })

  it('exposes the spec colors', () => {
    expect(NODE_COLORS.low).toBe('#10B981')
    expect(NODE_COLORS.mid).toBe('#F59E0B')
    expect(NODE_COLORS.high).toBe('#F43F5E')
  })
})
