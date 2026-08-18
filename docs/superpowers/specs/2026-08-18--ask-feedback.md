# Ask Feedback (Like / Dislike)

**Status:** approved 2026-08-18 — implementation in progress
**Branch:** `mcp-redesign-phase5`
**Owns:** `cmms-api/src/db/feedback.ts` (new), `cmms-api/src/routes/feedback.ts` (new),
`cmms-api/dashboard-v2/src/components/AnswerVoteBar.vue` (new),
`cmms-api/dashboard-v2/src/components/DislikeReasonModal.vue` (new),
`cmms-api/dashboard-v2/src/lib/feedback.ts` (new),
`cmms-api/dashboard-v2/src/routes/DislikedAnswersPage.vue` (new).

## 1. Why

The Ask chat is the production primary surface. The user has zero signal today
about whether answers are good, and the LLM has no signal about which answers
to fine-tune. This change adds a thumbs-up / thumbs-down control to every
assistant bubble and a feedback admin page that lists the disliked answers with
their full context. The reasons feed the next round of agent prompts and the
fine-tuning corpus.

## 2. UX

### User side

Footer row below every assistant bubble, right-aligned, compact:

```
                                [ 👍 ]  [ 👎 ]   ← icons only, no counts
```

- **Disabled while the assistant message is streaming.** No "I haven't seen the
  full answer yet" votes.
- **Active state highlights the chosen side** in `nct-soft` (purple). The other
  side stays in `text-muted`.
- **Counts are hidden on the user side** (no anchor / herding effect).
- Clicking the **active** side = un-vote. Clicking the **other** side = switch.
  Single round-trip POST.
- 👎 is **immediate** when admin "verbose dislike" is OFF. When ON, 👎 opens a
  modal with 5 reasons + "Other" (free text, required).
- 👍 is never gated by a modal.

### Admin side

`/admin` gets two new cards:
1. **Feedback totals** — `👍 124` / `👎 7` (all-time, app-wide).
2. **Verbose dislike** — toggle (default OFF).
3. **Disliked answers** link → `/admin/disliked`.

`/admin/disliked` is a master/detail:
- Left list: every disliked answer, newest first. Each row: question, customer,
  date, reason (if any), counter.
- Right drawer (teleported, same pattern as TicketInspector on mobile): full
  `final_text` + ticket cards + tool trace + the LLM prompt.

## 3. Data model

Two tables. The vote row stores the optional reason inline (5 fixed values +
`other:<text>`). The answer row stores the full agent payload snapshot at
vote time — we cannot reconstruct it later because the agent is non-deterministic
in tooling and the prompt changes frequently.

```sql
CREATE TABLE feedback_answers (
  answer_id    TEXT PRIMARY KEY,        -- ULID
  q            TEXT NOT NULL,
  final_text   TEXT NOT NULL,
  tool_trace   TEXT NOT NULL,           -- JSON
  model        TEXT NOT NULL,
  iterations   INTEGER NOT NULL,
  language     TEXT NOT NULL,
  resolved_customer TEXT,
  ticket_cards TEXT,                    -- JSON, nullable
  created_at   TEXT NOT NULL
);

CREATE TABLE feedback_votes (
  answer_id    TEXT NOT NULL REFERENCES feedback_answers(answer_id) ON DELETE CASCADE,
  uid          TEXT NOT NULL,           -- cmms_uid UUID
  vote         INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  reason       TEXT,                    -- nullable; 5 reasons + 'other:<text>'
  created_at   TEXT NOT NULL,
  PRIMARY KEY (answer_id, uid)
);

CREATE INDEX idx_feedback_votes_created_at ON feedback_votes(created_at DESC);
```

`COUNT(*)` per vote is the counter (Option A). Volume is small (one row per
vote), so the index is enough — no materialized stats.

## 4. Wire shape

### Identity
Anonymous UUID in `localStorage` key `cmms_uid`, generated on first visit with
`crypto.randomUUID()`. Sent on every request as `X-Cmms-Uid` header.

### POST /v1/feedback/vote
```jsonc
// request
{ "answer_id": "01H...", "vote": 1, "reason": "wrong customer" }

// response
{ "ok": true, "vote": 1, "answer_id": "01H..." }
```

Server is idempotent: same `(answer_id, uid)` UPSERT, with the rule
"clicking other side = switch, clicking same side = un-vote". Server computes
the new state from the existing row + the request's `vote`:

| existing | incoming | action | new state |
|----------|----------|--------|-----------|
| none     | 1        | INSERT | 1         |
| none     | -1       | INSERT | -1        |
| 1        | 1        | DELETE | none      |
| -1       | -1       | DELETE | none      |
| 1        | -1       | UPDATE | -1        |
| -1       | 1        | UPDATE | 1         |

If `vote = -1` and a `reason` is provided, the reason is upserted too. Empty /
null reason clears it.

### GET /v1/feedback/my-votes?answer_ids=a,b,c
Batch re-hydration for the user on page load / chat switch.
```jsonc
{ "votes": { "01H...": 1, "01H...": -1 } }
```

### GET /v1/feedback/counters
App-wide totals.
```jsonc
{ "likes": 124, "dislikes": 7 }
```

### GET /v1/feedback/disliked?limit=50&offset=0
Admin only. Returns a list of every disliked answer with its full payload.
```jsonc
{
  "items": [
    {
      "answer_id": "01H...",
      "q": "M26057 vezérlés?",
      "final_text": "...",
      "tool_trace": [...],
      "model": "gpt-4o",
      "iterations": 3,
      "language": "hu",
      "resolved_customer": "ANDRITZ KFT.",
      "ticket_cards": [...],
      "vote": { "uid": "...", "vote": -1, "reason": "wrong data", "created_at": "..." }
    }
  ],
  "total": 7,
  "limit": 50,
  "offset": 0
}
```

### GET /v1/feedback/settings
Admin only. Returns verbose flag.
```jsonc
{ "verbose_dislike": false }
```

### POST /v1/feedback/settings
Admin only.
```jsonc
// request
{ "verbose_dislike": true }
// response
{ "ok": true, "verbose_dislike": true }
```

Persists to `_meta` table as key `feedback_verbose_dislike`.

## 5. Server snapshot hook

`POST /v1/answer-agent` (the route in `cmms-api/src/routes/agent.ts`) gets a
post-success step that inserts a row into `feedback_answers` with the full
`AgentOutcome` JSON-serialized. The route maps `AgentFailure` to 502 BEFORE the
snapshot, so failed runs do not pollute the feedback table.

The snapshot is INSIDE the same Express handler (after `runAgent*` resolves,
before `res.json(out)`) so a single transaction commits the answer to the
client. We do NOT change the response body — the client still gets the
existing `AgentOutcome` shape, plus one new top-level field `answer_id` (the
ULID) that `AgentBody` already ignores.

## 6. Auth

- All `/v1/feedback/*` routes go through the existing `requireAuth({ write: false })`
  gate — anonymous-ish but only on the cmms-api side. The dashboard passes
  the bearer token (via the proxy) for user surface; admin passes the admin
  cookie via the proxy.
- The `X-Cmms-Uid` header is required for `POST /v1/feedback/vote` and
  `GET /v1/feedback/my-votes`. It is a UUID v4 — server validates format
  (regex). Invalid → 400.
- `GET /v1/feedback/disliked` and `GET|POST /v1/feedback/settings` require
  the admin cookie (re-checked in the route, not just in the proxy).

## 7. Frontend

### src/lib/feedback.ts
- `getOrCreateCmmsUid()` — `localStorage.cmms_uid ?? (set + return new UUID)`.
- `submitVote(answerId, vote, reason?)` — POST, header `X-Cmms-Uid`.
- `loadMyVotes(answerIds)` — GET batch.
- `loadCounters()` — GET.
- `loadDisliked(limit, offset)` — GET, admin surface.
- `loadSettings()` / `saveSettings(verbose)` — GET / POST, admin surface.
- All requests go through `useApi` for the user surface, and through a
  separate `useAdminApi` (cookie-only, with the 401 → /admin/login
  bounce) for the admin surface.

### src/components/AnswerVoteBar.vue
Props: `answerId: string`, `disabled: boolean`.
State: `myVote: -1 | 0 | 1` (0 = none), `busy: boolean`, `reasonModalOpen: boolean`.
Emits: `vote-submitted` (for tests).

Renders two icon buttons, calls `submitVote` on click. Optimistic toggle: if
vote already `1` and user clicks 👍, immediately flip to `0` and DELETE; if
0 → 1, POST immediately; on 5xx, revert and show a toast.

When `myVote === 0` and user clicks 👎:
- if settings.verbose_dislike === true → open DislikeReasonModal
- else → POST immediately, no reason

Disabled when `props.disabled` is true (assistant is still streaming).

### src/components/DislikeReasonModal.vue
Props: `open: boolean`, `answerId: string`.
Emits: `update:open`, `submitted` (with reason string).

5 reasons: "Wrong customer/device", "Wrong data (number/date/count)",
"Missed relevant ticket(s)", "Made something up", "Wording/format only".
Plus an "Other" radio that opens a required textarea (max 280 chars).
Submit disabled until one is selected. Close = Escape or backdrop click,
default focus on Cancel.

### AgentBody integration
A new <AnswerVoteBar> is appended at the bottom of every agent bubble. The
parent (AskPage) wires `disabled` to `store.busy` and `answerId` from the
new `agent.answer_id` field on `AnswerAgentResponse`.

### src/routes/DislikedAnswersPage.vue
Master/detail layout. List on left (cards), teleported drawer on right
(same HIG / sheet pattern as TicketInspector). Loads on mount via
`loadDisliked(0, 50)`, lazy-loads more on scroll.

## 8. Tests

- `cmms-api/tests/36-feedback.test.ts` — server: schema, vote insert/switch/un-vote,
  reason handling, counters, disliked list, settings, auth gates, snapshot hook
  writes a row on agent success and skips on AgentFailure.
- `cmms-api/dashboard-v2/tests/answer-vote-bar.spec.ts` — disabled-while-streaming,
  optimistic toggle, no-reason path, modal-open path, error revert, hydration
  on mount.
- `cmms-api/dashboard-v2/tests/dislike-reason-modal.spec.ts` — 5 reasons render,
  "Other" reveals textarea, submit disabled until selection, Escape closes,
  submit calls `submitVote(answerId, -1, reason)`.
- `cmms-api/dashboard-v2/tests/disliked-answers-page.spec.ts` — master list
  renders, drawer opens on click, drawer is teleported to body, 401 → /admin/login.
- `cmms-api/dashboard-v2/tests/feedback-store.spec.ts` — cmms_uid UUID v4
  stable across calls, new when localStorage empty.

## 9. Out of scope (v1)

- Per-answer counts on the user side (intentional — avoid herding).
- Correction free-text on the modal (v2: add a "what should it have said"
  field, fine-tuning corpus). For v1 we only persist the reason bucket.
- "Helpful but…" partial vote. A binary 👍/👎 is enough to start; the reason
  bucket does the fine-tune heavy lifting.
- Export to JSONL for fine-tuning. The admin page is enough to triage.
- Rate limiting. A real user can submit one vote per answer per second max
  (PRIMARY KEY enforces one row). Spamming the same uid across many answers
  is detected by an admin filter later.
