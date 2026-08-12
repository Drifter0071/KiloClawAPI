# Ask the CMMS — operator chat on the dashboard

**Date:** 2026-08-12
**Status:** design approved by user, implementation in progress
**Goal:** retire the $70/mo KiloClaw subscription by building an in-house "Ask the CMMS" surface that gives the operator (you) humanly-readable, uncertainty-aware answers to free-text questions in Hungarian or English, with zero LLM in the answer path.

## Background

The CMMS (65,921 tickets, 1.2M devices, integrated serviz_belso / szev_igeny / telephely_munka) already has a server-side router with 48 intents (`src/lib/router.ts`), evidence rendering, and date/status/result guards. Today the LLM picks one of 28 tools and the user gets variable answers (65% reproducibility).

The new design collapses the LLM's choice: one entry point, server picks top-3 candidates with confidence, dashboard renders the right one (or asks for confirmation).

## Scope

**In:**
- `/v1/answer` returns top-3 candidates with confidence, summary, evidence, follow-ups
- Two response modes: `answer` (top-1 confidence ≥ 0.6) and `confirm` (top-1 < 0.6, show top-2 as buttons)
- Dashboard UI: split layout, mobile-first, dark theme, optimistic UI, skeleton loaders, 8pt grid, native fonts
- `manifest.json` for PWA installability
- Tests: 100-question regression catalog, dashboard UI tests, scoring calibration tests

**Out:**
- LLM in the answer path (zero, per user decision)
- Customer-facing surface (operator-only)
- Token rotation UI (placeholder only)
- Revert UI (record request only)

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Dashboard UI (mobile-first PWA, password-gated)             │
│  ─ Split: chat (left) + evidence (right)                     │
│  ─ Optimistic submit, skeleton during fetch, expand on hover │
└──────────────────────────────────────────────────────────────┘
                            │ POST /dashboard/api/ask
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  cmms-api REST: POST /v1/answer (extended)                   │
│  ─ Runs scoring layer, returns mode=answer|confirm           │
│  ─ Bilingual summary, evidence, follow-ups                  │
│  ─ All existing guards apply per-candidate                   │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  src/lib/router.ts (existing) + src/lib/score.ts (new)       │
│  ─ All 48 rules fire in parallel, score each result          │
│  ─ Score = base + 0.20·entity_specificity + 0.10·keywords/5  │
│         + 0.05·date_present + 0.05·period_clean              │
│         − 0.10·same_family_collision                         │
│  ─ Intent families: ticket-search / stats / find-one / count│
│  ─ Top-3 returned. Threshold 0.6 (calibrated empirically).   │
└──────────────────────────────────────────────────────────────┘
```

## Response shape (POST /v1/answer)

```json
{
  "q": "Milyen vezérlés található az M26057 gépen?",
  "language": "hu",
  "mode": "answer",                  // or "confirm"
  "confidence": 0.81,                // top-1 score
  "threshold": 0.60,                 // threshold used
  "candidates": [
    { "rank": 1, "intent": "device_tickets_list",
      "score": 0.81, "score_breakdown": { ... },
      "filters": { "device": "M26057" },
      "summary": "1 találat minden időszak. Az első sorszám: B26071801.",
      "results": [...], "evidence": {...}, "follow_ups": [...] },
    { "rank": 2, "intent": "device_top_problem",
      "score": 0.42, ... },
    { "rank": 3, "intent": "find_related_tickets",
      "score": 0.31, ... }
  ],
  "rationale": "Top: device_tickets_list (0.81). Close: device_top_problem (0.42, 39pt below)."
}
```

In `confirm` mode, the per-candidate `summary`/`results`/`evidence`/`follow_ups` are still present (we return all 3 always, per user decision). The dashboard just doesn't render them until the user picks one.

## UI rules (from user input)

- **Optimistic UI:** chat message appears immediately on submit, typing indicator during fetch, evidence pane shows a shimmer skeleton
- **Anticipatory hover:** hovering "Other interpretations" prefetches the alternates' HTML
- **8pt grid:** all sizes are 4/8/16/24/32/48/64 multiples
- **Native fonts:** system-ui stack, no webfont downloads
- **Physics easing:** `cubic-bezier(0.0, 0.0, 0.2, 1)` for incoming, `cubic-bezier(0.4, 0.0, 1, 1)` for outgoing, `cubic-bezier(0.4, 0.0, 0.2, 1)` for in-place
- **Micro-durations:** 100-150ms desktop, 200-300ms mobile
- **Layered depth:** 0 canvas, 1 cards (1px border + 2-4px shadow), 2 overlays (8-16px shadow), 3 modals (24px+ shadow)
- **Touch targets:** 48px mobile, 32px desktop
- **Focus rings:** visible :focus-visible outline for keyboard
- **Manifest:** PWA installable, with `start_url` and `display: standalone`

## Mobile-first layout

- **Mobile (< 768px):** bottom tab bar (Ask, Stream, Map, Diff, Token), 4-col grid, single-column chat + evidence stacked, FAB for new question
- **Tablet (768-1023px):** top tabs, 8-col grid, two-column chat + evidence
- **Desktop (≥ 1024px):** left sidebar nav, 12-col grid with 24px gutter, split chat + evidence (cap at 1400px)
- **Ultra-wide (≥ 1920px):** same as desktop, max-width 1400px container

## Components

- `AskChat` — chat column with messages, input, follow-up pills
- `EvidencePanel` — right column with cited tickets
- `ConfirmMode` — two buttons + "Show me all 3 anyway" expander
- `ConfidenceBadge` — number + colored band (≥0.7 green, 0.4-0.7 amber, <0.4 red)
- `FollowUpPill` — clickable question
- `Skeleton` — shimmer placeholder during fetch
- `Tabs` — bottom tab bar (mobile) / left sidebar (desktop)

## Tests

1. **Scoring layer** — 100-question catalog, each question's top-1 must be in expected intent. Plus new test: top-3 must include expected intent with score ≥ 0.5
2. **Confidence calibration** — histogram across 100 questions, threshold placement
3. **Mode switching** — questions with score < 0.6 must return `mode: "confirm"`, ≥ 0.6 must return `mode: "answer"`
4. **Dashboard UI** — Playwright? Or just a fetch-level test that the rendered HTML has the right structure
5. **Manifest.json** — present, valid, points at the right start_url

## Deployment

- mcp-server.ts already serves the dashboard on 8788, password-gated by DASHBOARD_PASSWORD
- deploy-mcp.ts uploads the new `dashboard/ask/` folder and `dashboard/manifest.json`
- No DB changes, no schema migration
- Smoke test: M26057 / M09192 / M17191 must still return B26071801 / B26061810 / B25072420 (or closest) with mode=answer

## Migration / non-breaking

- `/v1/answer` adds new fields (`mode`, `candidates[]`, `confidence`, `threshold`, `rationale`) — additive
- Old single-intent fields (`intent`, `primitive`, `filters`, `summary`, `results`, etc.) still present at the top level for backwards compat
- The dashboard already at `/dashboard` is replaced by the new mobile-first version
- The old 4-tab dashboard.html is kept at `/dashboard/legacy` (one nav item away) for anyone who still wants the spatial map / diff views
