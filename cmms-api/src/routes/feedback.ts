// src/routes/feedback.ts
//
// REST endpoints for the Ask Like/Dislike feature.
//
// Two router factories:
//   userFeedbackRouter(dbs)    — read-gated (vote, my-votes, counters)
//   adminFeedbackRouter(dbs)   — write-gated (disliked list, settings)
//
// Both are mounted in server.ts with the appropriate requireAuth.
// The split exists so direct cmms-api callers with the read-only
// bearer token cannot reach admin-only endpoints — the proxy in
// dashboard/server.ts is a convenience, not a security boundary.
//
// User surface (mounted under requireAuth({ write: false })):
//   POST /v1/feedback/vote
//     body: { answer_id, vote, reason? }
//     hdr:  X-Cmms-Uid: <UUID>     (required)
//     resp: { ok, vote, answer_id }
//
//   GET  /v1/feedback/my-votes?answer_ids=a,b,c
//     hdr:  X-Cmms-Uid             (required)
//     resp: { votes: { [answer_id]: 1 | -1 } }
//
//   GET  /v1/feedback/counters
//     resp: { likes, dislikes }    (all-time totals)
//
// Admin surface (mounted under requireAuth({ write: true })):
//   GET  /v1/feedback/disliked?limit=50&offset=0
//     resp: { items: [...], total, limit, offset }
//   GET  /v1/feedback/settings
//     resp: { verbose_dislike }
//   POST /v1/feedback/settings
//     body: { verbose_dislike }
//     resp: { ok, verbose_dislike }

import { Router as makeRouter, type Request, type Response, type Router } from "express";
import type { OpenDbs } from "../db/open";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// 5 fixed reasons + "other:<text>" in the wire shape. Server validates
// the value against this list. The "other" reason is the only one
// that carries free text; the rest are constants.
const FIXED_REASONS = new Set([
  "wrong customer/device",
  "wrong data (number/date/count)",
  "missed relevant ticket(s)",
  "made something up",
  "wording/format only",
]);
const OTHER_PREFIX = "other:";
const OTHER_MAX_LEN = 280;
const CORRECTION_MAX_LEN = 1000;

// Acceptable X-Cmms-Uid: any UUID v1-v8 (8-4-4-4-12 hex). The
// frontend uses crypto.randomUUID() which is v4.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function badRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ error: { code, message } });
}

function getUid(req: Request): string | null {
  const h = req.header("x-cmms-uid") ?? req.header("X-Cmms-Uid") ?? "";
  if (!UUID_RE.test(h.trim())) return null;
  return h.trim().toLowerCase();
}

function normalizeReason(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (s.length === 0) return null;
  if (FIXED_REASONS.has(s)) return s;
  if (s.startsWith(OTHER_PREFIX)) {
    const rest = s.slice(OTHER_PREFIX.length).trim();
    if (rest.length === 0) return null;
    return OTHER_PREFIX + rest.slice(0, OTHER_MAX_LEN);
  }
  return null; // unknown reason → reject
}

// -----------------------------------------------------------------------------
// Snapshot insertion (called by the agent route)
// -----------------------------------------------------------------------------
//
// Called by the agent route AFTER `runAgent*` resolves and BEFORE
// `res.json(out)`. We keep it here (not in the route file) so the
// insert is testable from tests/36-feedback.test.ts without spinning
// up the agent.

export type AgentSnapshotInput = {
  answer_id: string;
  q: string;
  final_text: string;
  tool_trace: unknown;
  model: string;
  iterations: number;
  language: string;
  resolved_customer: string | null;
  ticket_cards: unknown;
};

export function insertFeedbackAnswer(dbs: OpenDbs, snap: AgentSnapshotInput): void {
  dbs.stmts.insertFeedbackAnswer.run(
    snap.answer_id,
    snap.q,
    snap.final_text,
    JSON.stringify(snap.tool_trace ?? []),
    snap.model,
    Math.max(0, Math.floor(snap.iterations)),
    snap.language,
    snap.resolved_customer,
    snap.ticket_cards == null ? null : JSON.stringify(snap.ticket_cards),
    new Date().toISOString(),
  );
}

// -----------------------------------------------------------------------------
// User surface
// -----------------------------------------------------------------------------

export function userFeedbackRouter(dbs: OpenDbs): Router {
  const r = makeRouter();

  // POST /v1/feedback/vote
  //
  // Idempotent state machine — see spec §4. The 6 cases (existing ×
  // incoming) are:
  //   none × 1    → INSERT
  //   none × -1   → INSERT
  //   1 × 1       → DELETE (un-vote)
  //   -1 × -1     → DELETE (un-vote)
  //   1 × -1      → UPDATE  (switch)
  //   -1 × 1      → UPDATE  (switch)
  r.post("/v1/feedback/vote", (req: Request, res: Response) => {
    const uid = getUid(req);
    if (!uid) {
      return badRequest(res, "missing_uid", "X-Cmms-Uid header is required and must be a UUID");
    }
    const body = (req.body ?? {}) as { answer_id?: string; vote?: number; reason?: unknown };
    const answerId = typeof body.answer_id === "string" ? body.answer_id.trim() : "";
    if (!answerId) {
      return badRequest(res, "missing_answer_id", "answer_id is required");
    }
    if (body.vote !== 1 && body.vote !== -1) {
      return badRequest(res, "invalid_vote", "vote must be 1 (like) or -1 (dislike)");
    }
    const reason = body.vote === -1 ? normalizeReason(body.reason) : null;
    if (body.vote === -1 && body.reason != null && reason === null) {
      return badRequest(res, "invalid_reason",
        "reason must be one of: wrong customer/device, wrong data (number/date/count), missed relevant ticket(s), made something up, wording/format only, or other:<text>");
    }
    // Ensure the answer row exists. (Snapshot is inserted by the agent
    // route; we do not silently create one here — voting on a non-
    // existent answer is a 404, not a silent insert.)
    const answer = dbs.stmts.getFeedbackAnswer.get(answerId) as { answer_id: string } | undefined;
    if (!answer) {
      return res.status(404).json({ error: { code: "answer_not_found", message: "No feedback_answers row with that id" } });
    }

    const existing = dbs.stmts.getFeedbackVote.get(answerId, uid) as { vote: number } | undefined;
    const incoming = body.vote;
    const now = new Date().toISOString();

    if (!existing) {
      dbs.stmts.upsertFeedbackVote.run(answerId, uid, incoming, reason, now);
    } else if (existing.vote === incoming) {
      // Same side = un-vote.
      dbs.stmts.deleteFeedbackVote.run(answerId, uid);
    } else {
      // Other side = switch.
      dbs.stmts.upsertFeedbackVote.run(answerId, uid, incoming, reason, now);
    }
    return res.json({ ok: true, vote: incoming, answer_id: answerId });
  });

  // GET /v1/feedback/my-votes?answer_ids=a,b,c
  r.get("/v1/feedback/my-votes", (req: Request, res: Response) => {
    const uid = getUid(req);
    if (!uid) {
      return badRequest(res, "missing_uid", "X-Cmms-Uid header is required and must be a UUID");
    }
    const idsParam = (req.query.answer_ids ?? "").toString().trim();
    if (!idsParam) {
      return res.json({ votes: {} });
    }
    const ids = idsParam.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (ids.length === 0) {
      return res.json({ votes: {} });
    }
    if (ids.length > 200) {
      return badRequest(res, "too_many_ids", "answer_ids supports up to 200 ids per request");
    }
    const json = JSON.stringify(ids);
    const rows = dbs.stmts.getFeedbackVotesForUid.all(uid, json) as Array<{ answer_id: string; vote: number }>;
    const out: Record<string, 1 | -1> = {};
    for (const row of rows) out[row.answer_id] = row.vote === 1 ? 1 : -1;
    return res.json({ votes: out });
  });

  // GET /v1/feedback/my-corrections?answer_ids=a,b,c
  //   hdr:  X-Cmms-Uid             (required)
  //   resp: { corrections: { [answer_id]: { correction, created_at } } }
  //
  // Batched read of THIS user's corrections for the given answer_ids.
  // The Ask page uses this to hydrate the "Visszajelzés elküldve" state
  // for every rendered bubble in a single round-trip, the same way
  // /my-votes hydrates the thumb state. Latest correction per pair wins
  // (the INSERT … ON CONFLICT clause guarantees uniqueness on
  // (answer_id, uid), so there's at most one row per pair).
  r.get("/v1/feedback/my-corrections", (req: Request, res: Response) => {
    const uid = getUid(req);
    if (!uid) {
      return badRequest(res, "missing_uid", "X-Cmms-Uid header is required and must be a UUID");
    }
    const idsParam = (req.query.answer_ids ?? "").toString().trim();
    if (!idsParam) {
      return res.json({ corrections: {} });
    }
    const ids = idsParam.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (ids.length === 0) {
      return res.json({ corrections: {} });
    }
    if (ids.length > 200) {
      return badRequest(res, "too_many_ids", "answer_ids supports up to 200 ids per request");
    }
    const json = JSON.stringify(ids);
    const rows = dbs.stmts.getFeedbackCorrectionsForUid.all(uid, json) as Array<{
      answer_id: string;
      correction: string;
      created_at: string;
    }>;
    const out: Record<string, { correction: string; created_at: string }> = {};
    for (const row of rows) {
      // The query orders DESC by created_at, so a later iteration of the
      // same answer_id would be older. First hit wins.
      if (out[row.answer_id] === undefined) {
        out[row.answer_id] = { correction: row.correction, created_at: row.created_at };
      }
    }
    return res.json({ corrections: out });
  });

  // GET /v1/feedback/counters
  r.get("/v1/feedback/counters", (_req: Request, res: Response) => {
    const row = dbs.stmts.getFeedbackCounters.get() as { likes: number; dislikes: number };
    return res.json({ likes: row.likes ?? 0, dislikes: row.dislikes ?? 0 });
  });

  // POST /v1/feedback/correction
  //   body: { answer_id, correction }
  //   hdr:  X-Cmms-Uid             (required)
  //   resp: { ok, answer_id, correction, created_at }
  //
  // The user submits free-text "what the answer should have been".
  // Latest wins (UPSERT). Capped at CORRECTION_MAX_LEN.
  r.post("/v1/feedback/correction", (req: Request, res: Response) => {
    const uid = getUid(req);
    if (!uid) {
      return badRequest(res, "missing_uid", "X-Cmms-Uid must be a valid UUID");
    }
    const body = (req.body ?? {}) as { answer_id?: unknown; correction?: unknown };
    const answerId = typeof body.answer_id === "string" ? body.answer_id.trim() : "";
    const correctionRaw = typeof body.correction === "string" ? body.correction.trim() : "";
    if (answerId.length === 0) {
      return badRequest(res, "missing_answer_id", "answer_id is required");
    }
    if (correctionRaw.length === 0) {
      return badRequest(res, "missing_correction", "correction is required (1..1000 chars)");
    }
    if (correctionRaw.length > CORRECTION_MAX_LEN) {
      return badRequest(
        res,
        "correction_too_long",
        `correction must be at most ${CORRECTION_MAX_LEN} characters (got ${correctionRaw.length})`,
      );
    }
    // FK guard: the answer must exist in feedback_answers, otherwise
    // the foreign key on the corrections table will reject the insert
    // and we'd 500 the user for what is really a typo. 404 explicitly.
    const answer = dbs.stmts.getFeedbackAnswer.get(answerId) as { answer_id: string } | undefined;
    if (!answer) {
      return res
        .status(404)
        .json({ error: { code: "answer_not_found", message: "No feedback_answers row with that id" } });
    }
    const now = new Date().toISOString();
    dbs.stmts.insertFeedbackCorrection.run(answerId, uid, correctionRaw, now);
    return res.json({ ok: true, answer_id: answerId, correction: correctionRaw, created_at: now });
  });

  // GET /v1/feedback/answer/:answerId
  //   Phase 8 (2026-08-24, F4 in the brainstorm) — shareable answer
  //   links. The SPA renders a "Share" button on each completed
  //   agent bubble; tapping it copies the URL `/dashboard/answer/<id>`
  //   which the operator can paste to a colleague. Opening the URL
  //   lands on the SPA's read-only answer view, which calls this
  //   endpoint to fetch the full snapshot.
  //
  //   Auth: read-gated (login required). The link is permanent but
  //   only works for authenticated users (user said "login-required,
  //   permanent").
  r.get("/v1/feedback/answer/:answerId", (req: Request, res: Response) => {
    const answerId = String(req.params.answerId ?? "").trim();
    if (answerId.length === 0 || answerId.length > 64) {
      res.status(400).json({ error: { code: "bad_request", message: "answerId required" } });
      return;
    }
    const row = dbs.stmts.getFeedbackAnswerFull.get(answerId) as
      | {
          answer_id: string;
          q: string;
          final_text: string;
          tool_trace: string;
          model: string;
          iterations: number;
          language: string;
          created_at: string;
        }
      | undefined;
    if (!row) {
      res.status(404).json({ error: { code: "answer_not_found", message: "Unknown answer id" } });
      return;
    }
    let toolTrace: unknown = [];
    if (row.tool_trace) {
      try {
        toolTrace = JSON.parse(row.tool_trace);
      } catch {
        toolTrace = [];
      }
    }
    res.json({
      answer_id: row.answer_id,
      q: row.q,
      final_text: row.final_text,
      model: row.model,
      iterations: row.iterations,
      language: row.language,
      created_at: row.created_at,
      tool_trace: toolTrace,
    });
  });

  return r;
}

// -----------------------------------------------------------------------------
// Admin surface
// -----------------------------------------------------------------------------

export function adminFeedbackRouter(dbs: OpenDbs): Router {
  const r = makeRouter();

  // GET /v1/feedback/disliked?limit=50&offset=0
  //   resp: {
  //     items: Array<{
  //       answer_id, q, final_text, tool_trace, model, iterations, language,
  //       resolved_customer, ticket_cards, created_at,
  //       vote: { uid, vote, reason, created_at },
  //       correction: { uid, correction, created_at } | null,  // latest across all uids
  //       correction_count: number,                              // number of distinct uids
  //     }>,
  //     total, limit, offset
  //   }
  //
  // Joins feedback_corrections so the admin can see, on the same
  // card, the operator's "what the answer should have been" follow-up.
  // Each (answer_id, uid) pair has at most one row (PK), so the
  // MAX(created_at) lookup yields the single most recent correction
  // across the whole operator pool; `correction_count` reports how
  // many distinct uids submitted one (so the admin can see whether
  // multiple operators independently reached the same answer).
  r.get("/v1/feedback/disliked", (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? "50") || 50));
    const offset = Math.max(0, Math.min(100_000, Number(req.query.offset ?? "0") || 0));
    const rows = dbs.stmts.listDislikedFeedbackWithCorrection.all(limit, offset) as Array<{
      answer_id: string;
      q: string;
      final_text: string;
      tool_trace: string;
      model: string;
      iterations: number;
      language: string;
      resolved_customer: string | null;
      ticket_cards: string | null;
      created_at: string;
      vote_uid: string;
      vote: number;
      reason: string | null;
      vote_at: string;
      correction_uid: string | null;
      correction: string | null;
      correction_at: string | null;
      correction_count: number;
    }>;
    const totalRow = dbs.stmts.countDislikedFeedback.get() as { n: number };
    const items = rows.map((row) => ({
      answer_id: row.answer_id,
      q: row.q,
      final_text: row.final_text,
      tool_trace: JSON.parse(row.tool_trace),
      model: row.model,
      iterations: row.iterations,
      language: row.language,
      resolved_customer: row.resolved_customer,
      ticket_cards: row.ticket_cards ? JSON.parse(row.ticket_cards) : null,
      created_at: row.created_at,
      vote: {
        uid: row.vote_uid,
        vote: row.vote,
        reason: row.reason,
        created_at: row.vote_at,
      },
      correction:
        row.correction && row.correction_uid && row.correction_at
          ? {
              uid: row.correction_uid,
              correction: row.correction,
              created_at: row.correction_at,
            }
          : null,
      correction_count: row.correction_count ?? 0,
    }));
    return res.json({ items, total: totalRow.n, limit, offset });
  });

  // GET /v1/feedback/settings
  r.get("/v1/feedback/settings", (_req: Request, res: Response) => {
    const row = dbs.stmts.getMeta.get("feedback_verbose_dislike") as { value: string } | undefined;
    const raw = (row?.value ?? "").toLowerCase();
    return res.json({ verbose_dislike: raw === "1" || raw === "true" || raw === "yes" || raw === "on" });
  });

  // POST /v1/feedback/settings
  r.post("/v1/feedback/settings", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { verbose_dislike?: boolean };
    if (typeof body.verbose_dislike !== "boolean") {
      return badRequest(res, "invalid_verbose_dislike", "verbose_dislike must be a boolean");
    }
    dbs.stmts.setMeta.run("feedback_verbose_dislike", body.verbose_dislike ? "1" : "0");
    return res.json({ ok: true, verbose_dislike: body.verbose_dislike });
  });

  return r;
}

// Back-compat: the original export name. Returns the user surface.
// The admin surface must be mounted separately by the caller.
export function feedbackRouter(dbs: OpenDbs): Router {
  return userFeedbackRouter(dbs);
}
