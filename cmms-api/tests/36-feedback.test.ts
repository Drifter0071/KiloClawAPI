// 36-feedback.test.ts
//
// Server tests for the Ask Like/Dislike feature.
//
// Coverage:
//   1. Schema is present in the spec DB (feedback_answers + feedback_votes)
//   2. POST /v1/feedback/vote — state machine: insert, switch, un-vote
//   3. POST /v1/feedback/vote — input validation: missing/invalid uid,
//      vote, reason
//   4. POST /v1/feedback/vote — 404 when answer_id is unknown
//   5. GET  /v1/feedback/my-votes — batch re-hydration
//   6. GET  /v1/feedback/counters — all-time totals
//   7. GET  /v1/feedback/disliked — admin only (write token)
//   8. GET/POST /v1/feedback/settings — admin only + boolean round-trip
//   9. Snapshot hook: insertFeedbackAnswer writes a row that the vote
//      endpoint can find.
//
// The user surface is mounted under the read gate; the admin surface
// is mounted under the write gate (server.ts). We hit the live server
// for every case so the auth wiring is exercised, not just the
// route bodies.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildFixture, cleanupFixture, type Fixture } from "./fixtures/fixture";
import { startTestServer, authHeaders, type TestServer } from "./harness";
import { insertFeedbackAnswer } from "../src/routes/feedback";

let fix: Fixture;
let srv: TestServer;

const UID_A = "11111111-2222-3333-4444-555555555555";
const UID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ANSWER_1 = "01H00000000000000000000001";
const ANSWER_2 = "01H00000000000000000000002";
const ANSWER_3 = "01H00000000000000000000003";

function seed(srv: TestServer, answerId: string, q: string, finalText: string): void {
  insertFeedbackAnswer(srv.dbs, {
    answer_id: answerId,
    q,
    final_text: finalText,
    tool_trace: [{ name: "answer_question", args: { q }, ok: true }],
    model: "gpt-4o",
    iterations: 1,
    language: "hu",
    resolved_customer: "ANDRITZ KFT.",
    ticket_cards: [{ sorszam: "B2408001", customer_name: "ANDRITZ KFT.", status: "closed" }],
  });
}

beforeAll(async () => {
  fix = buildFixture([]);
  srv = await startTestServer(fix);
  seed(srv, ANSWER_1, "M26057 vezérlés?", "Az NCT2000 vezérlő firmware frissítése szükséges.");
  seed(srv, ANSWER_2, "M09192 alkatrész?", "A kérésre a B2407001 ticket tartozik, lásd lentebb.");
  seed(srv, ANSWER_3, "kritikus hiba?", "A leolvasás a szenzoron hibás.");
});

afterAll(() => {
  srv.stop();
  cleanupFixture(fix);
});

describe("POST /v1/feedback/vote", () => {
  test("requires X-Cmms-Uid header", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ answer_id: ANSWER_1, vote: 1 }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_uid");
  });

  test("rejects malformed uid (not a UUID)", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": "not-a-uuid" }),
      body: JSON.stringify({ answer_id: ANSWER_1, vote: 1 }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_uid");
  });

  test("rejects invalid vote value", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, vote: 7 }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_vote");
  });

  test("returns 404 for unknown answer_id", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: "does-not-exist", vote: 1 }),
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("answer_not_found");
  });

  test("rejects unknown reason on dislike", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, vote: -1, reason: "not a real reason" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_reason");
  });

  test("insert, switch, un-vote state machine", async () => {
    // 1) INSERT like
    const r1 = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, vote: 1 }),
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true, vote: 1, answer_id: ANSWER_1 });

    // verify in db
    const row1 = srv.dbs.stmts.getFeedbackVote.get(ANSWER_1, UID_A) as { vote: number } | undefined;
    expect(row1?.vote).toBe(1);

    // 2) SWITCH to dislike
    const r2 = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, vote: -1, reason: "wrong data (number/date/count)" }),
    });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true, vote: -1, answer_id: ANSWER_1 });
    const row2 = srv.dbs.stmts.getFeedbackVote.get(ANSWER_1, UID_A) as { vote: number; reason: string };
    expect(row2.vote).toBe(-1);
    expect(row2.reason).toBe("wrong data (number/date/count)");

    // 3) Same side = un-vote
    const r3 = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, vote: -1 }),
    });
    expect(r3.status).toBe(200);
    const row3 = srv.dbs.stmts.getFeedbackVote.get(ANSWER_1, UID_A) as { vote: number } | null | undefined;
    expect(row3 == null).toBe(true);
  });

  test("reason is reset to null on a like (reason is dislike-only)", async () => {
    // Dislike with reason
    const r1 = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }),
      body: JSON.stringify({ answer_id: ANSWER_2, vote: -1, reason: "made something up" }),
    });
    expect(r1.status).toBe(200);
    // Switch to like — reason should be cleared
    const r2 = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }),
      body: JSON.stringify({ answer_id: ANSWER_2, vote: 1 }),
    });
    expect(r2.status).toBe(200);
    const row = srv.dbs.stmts.getFeedbackVote.get(ANSWER_2, UID_B) as { vote: number; reason: string | null };
    expect(row.vote).toBe(1);
    expect(row.reason).toBeNull();
  });

  test("'other:<text>' reason is preserved verbatim (max 280 chars)", async () => {
    const txt = "A2 ".repeat(100).trim();
    const r = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_2, vote: -1, reason: `other:${txt}` }),
    });
    expect(r.status).toBe(200);
    const row = srv.dbs.stmts.getFeedbackVote.get(ANSWER_2, UID_A) as { reason: string };
    expect(row.reason.startsWith("other:")).toBe(true);
    // The 'other:' prefix + body is capped at 280 chars for the body part
    // — the row we wrote had ~300 chars of body. The body part should
    // be at most 280.
    expect(row.reason.length).toBeLessThanOrEqual("other:".length + 280);
  });
});

describe("GET /v1/feedback/my-votes", () => {
  test("returns empty map when answer_ids is empty", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/my-votes?answer_ids=`, {
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ votes: {} });
  });

  test("returns only votes owned by the requesting uid", async () => {
    // Seed: UID_A disliked ANSWER_3, UID_B liked ANSWER_3
    await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_3, vote: -1, reason: "wording/format only" }),
    });
    await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }),
      body: JSON.stringify({ answer_id: ANSWER_3, vote: 1 }),
    });

    const ra = await fetch(
      `${srv.url}/v1/feedback/my-votes?answer_ids=${ANSWER_1},${ANSWER_2},${ANSWER_3}`,
      { headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }) },
    );
    expect(ra.status).toBe(200);
    const a = (await ra.json()) as { votes: Record<string, number> };
    // UID_A: ANSWER_1 was un-voted, ANSWER_2 dislike with "other:…",
    // ANSWER_3 dislike.
    expect(a.votes[ANSWER_1]).toBeUndefined();
    expect(a.votes[ANSWER_2]).toBe(-1);
    expect(a.votes[ANSWER_3]).toBe(-1);

    const rb = await fetch(
      `${srv.url}/v1/feedback/my-votes?answer_ids=${ANSWER_3}`,
      { headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }) },
    );
    const b = (await rb.json()) as { votes: Record<string, number> };
    expect(b.votes[ANSWER_3]).toBe(1);
  });

  test("rejects more than 200 ids", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `id${i}`).join(",");
    const r = await fetch(`${srv.url}/v1/feedback/my-votes?answer_ids=${ids}`, {
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("too_many_ids");
  });
});

describe("GET /v1/feedback/my-corrections", () => {
  test("requires X-Cmms-Uid header", async () => {
    const r = await fetch(
      `${srv.url}/v1/feedback/my-corrections?answer_ids=${ANSWER_1}`,
      { headers: authHeaders(srv.readToken) },
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_uid");
  });

  test("returns empty map when answer_ids is empty", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/my-corrections?answer_ids=`, {
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ corrections: {} });
  });

  test("returns only the requesting user's corrections, latest per answer_id", async () => {
    // Seed: UID_A corrected ANSWER_3, then UPDATED it; UID_B corrected
    // ANSWER_1.
    const r1 = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_3, correction: "first try" }),
    });
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { created_at: string };
    // Force a deterministic newer created_at by waiting a millisecond;
    // the server uses ISO-now, so a small sleep is enough.
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_3, correction: "second try" }),
    });
    expect(r2.status).toBe(200);
    const r3 = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }),
      body: JSON.stringify({ answer_id: ANSWER_1, correction: "B says" }),
    });
    expect(r3.status).toBe(200);

    const ra = await fetch(
      `${srv.url}/v1/feedback/my-corrections?answer_ids=${ANSWER_1},${ANSWER_2},${ANSWER_3}`,
      { headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }) },
    );
    expect(ra.status).toBe(200);
    const a = (await ra.json()) as {
      corrections: Record<string, { correction: string; created_at: string }>;
    };
    // UID_A: ANSWER_3 latest "second try" (not "first try"). ANSWER_1
    // was corrected only by UID_B — should NOT show up for UID_A.
    // ANSWER_2 untouched.
    expect(a.corrections[ANSWER_1]).toBeUndefined();
    expect(a.corrections[ANSWER_2]).toBeUndefined();
    expect(a.corrections[ANSWER_3]).toBeDefined();
    expect(a.corrections[ANSWER_3]!.correction).toBe("second try");
    expect(a.corrections[ANSWER_3]!.created_at >= j1.created_at).toBe(true);

    const rb = await fetch(
      `${srv.url}/v1/feedback/my-corrections?answer_ids=${ANSWER_1}`,
      { headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }) },
    );
    const b = (await rb.json()) as {
      corrections: Record<string, { correction: string }>;
    };
    expect(b.corrections[ANSWER_1]?.correction).toBe("B says");
    // UID_B has nothing for ANSWER_3 (UID_A did, not UID_B).
    expect(b.corrections[ANSWER_3]).toBeUndefined();
  });

  test("rejects more than 200 ids", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `id${i}`).join(",");
    const r = await fetch(`${srv.url}/v1/feedback/my-corrections?answer_ids=${ids}`, {
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("too_many_ids");
  });
});

describe("GET /v1/feedback/counters", () => {
  test("returns the all-time totals", async () => {
    // After the suite so far:
    //   UID_A: ANSWER_2 dislike (-1), ANSWER_3 dislike (-1)
    //   UID_B: ANSWER_2 like (1), ANSWER_3 like (1)
    //   ANSWER_1: nothing
    const r = await fetch(`${srv.url}/v1/feedback/counters`, {
      headers: authHeaders(srv.readToken),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { likes: number; dislikes: number };
    expect(body.likes).toBeGreaterThanOrEqual(2);
    expect(body.dislikes).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /v1/feedback/disliked (admin only)", () => {
  test("rejects the read token (write gate)", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/disliked?limit=5`, {
      headers: authHeaders(srv.readToken),
    });
    expect(r.status).toBe(403);
  });

  test("returns disliked answers with full snapshot", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/disliked?limit=50&offset=0`, {
      headers: authHeaders(srv.writeToken),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{
        answer_id: string;
        q: string;
        final_text: string;
        tool_trace: unknown[];
        model: string;
        iterations: number;
        language: string;
        resolved_customer: string | null;
        ticket_cards: unknown;
        created_at: string;
        vote: { uid: string; vote: number; reason: string | null; created_at: string };
        correction: { uid: string; correction: string; created_at: string } | null;
        correction_count: number;
      }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.total).toBeGreaterThanOrEqual(2);
    // Find ANSWER_3 in the list
    const row = body.items.find((i) => i.answer_id === ANSWER_3);
    expect(row).toBeDefined();
    expect(row!.q).toBe("kritikus hiba?");
    expect(row!.final_text).toContain("szenzoron");
    expect(row!.model).toBe("gpt-4o");
    expect(row!.iterations).toBe(1);
    expect(row!.language).toBe("hu");
    expect(row!.resolved_customer).toBe("ANDRITZ KFT.");
    expect(Array.isArray(row!.tool_trace)).toBe(true);
    expect(Array.isArray(row!.ticket_cards)).toBe(true);
    expect(row!.vote.vote).toBe(-1);
    expect(row!.vote.reason).toBe("wording/format only");
    // ANSWER_3 was never corrected in this test file — fields must
    // still be present in the payload (typed, even when null/0).
    expect(row!.correction).toBeNull();
    expect(row!.correction_count).toBe(0);
  });

  test("appends the operator's 'proposed correct answer' to each disliked card", async () => {
    // Two different operators each submit a correction for ANSWER_1
    // (the only one we know is liked in earlier tests; we don't care
    // about its vote state here, we only care that the join surfaces
    // the latest correction + the count of distinct uids).
    const c1 = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, correction: "UID_A says: use B2408001" }),
    });
    expect(c1.status).toBe(200);
    await new Promise((res) => setTimeout(res, 5));
    const c2 = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }),
      body: JSON.stringify({ answer_id: ANSWER_1, correction: "UID_B says: also use B2408001" }),
    });
    expect(c2.status).toBe(200);

    // ANSWER_1 was not disliked in this file's seed — it was just
    // LIKED earlier. So it should NOT show up in the admin disliked
    // list. Use ANSWER_3 (disliked) and submit a correction to it so
    // the join logic has something to return.
    const c3 = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({
        answer_id: ANSWER_3,
        correction: "A szenzor ténylegesen a B2408001 vonalhoz tartozik, javítva.",
      }),
    });
    expect(c3.status).toBe(200);
    await new Promise((res) => setTimeout(res, 5));
    const c4 = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }),
      body: JSON.stringify({
        answer_id: ANSWER_3,
        correction: "Egyetértek, a javítás a B2408001.",
      }),
    });
    expect(c4.status).toBe(200);

    const r = await fetch(`${srv.url}/v1/feedback/disliked?limit=50&offset=0`, {
      headers: authHeaders(srv.writeToken),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: Array<{
        answer_id: string;
        correction: { uid: string; correction: string; created_at: string } | null;
        correction_count: number;
      }>;
    };
    const row = body.items.find((i) => i.answer_id === ANSWER_3);
    expect(row).toBeDefined();
    // Latest correction is the UID_B one (later created_at).
    expect(row!.correction).not.toBeNull();
    expect(row!.correction!.uid).toBe(UID_B);
    expect(row!.correction!.correction).toBe("Egyetértek, a javítás a B2408001.");
    // Both uids contributed → count is 2.
    expect(row!.correction_count).toBe(2);
  });
});

describe("GET/POST /v1/feedback/settings (admin only)", () => {
  test("default is verbose_dislike=false", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/settings`, {
      headers: authHeaders(srv.writeToken),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { verbose_dislike: boolean };
    expect(body.verbose_dislike).toBe(false);
  });

  test("rejects the read token (write gate)", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/settings`, {
      headers: authHeaders(srv.readToken),
    });
    expect(r.status).toBe(403);
  });

  test("POST with non-boolean returns 400", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/settings`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ verbose_dislike: "yes" }),
    });
    expect(r.status).toBe(400);
  });

  test("round-trip: turn on, read back, turn off", async () => {
    const on = await fetch(`${srv.url}/v1/feedback/settings`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ verbose_dislike: true }),
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, verbose_dislike: true });
    const g1 = await fetch(`${srv.url}/v1/feedback/settings`, {
      headers: authHeaders(srv.writeToken),
    });
    expect((await g1.json())).toEqual({ verbose_dislike: true });

    const off = await fetch(`${srv.url}/v1/feedback/settings`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ verbose_dislike: false }),
    });
    expect(off.status).toBe(200);
    const g2 = await fetch(`${srv.url}/v1/feedback/settings`, {
      headers: authHeaders(srv.writeToken),
    });
    expect((await g2.json())).toEqual({ verbose_dislike: false });
  });
});

describe("snapshot hook (insertFeedbackAnswer)", () => {
  test("writes a row that the vote endpoint can find", async () => {
    const id = "01HDEAD00000000000000000";
    insertFeedbackAnswer(srv.dbs, {
      answer_id: id,
      q: "M99999 snapshot?",
      final_text: "snapshot test",
      tool_trace: [],
      model: "gpt-4o",
      iterations: 1,
      language: "hu",
      resolved_customer: null,
      ticket_cards: null,
    });
    // Vote should now succeed
    const r = await fetch(`${srv.url}/v1/feedback/vote`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }),
      body: JSON.stringify({ answer_id: id, vote: 1 }),
    });
    expect(r.status).toBe(200);
  });
});

describe("POST /v1/feedback/correction", () => {
  test("requires X-Cmms-Uid header", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ answer_id: ANSWER_1, correction: "x" }),
    });
    expect(r.status).toBe(400);
  });

  test("rejects missing correction text", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, correction: "" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_correction");
  });

  test("rejects correction over 1000 chars", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, correction: "x".repeat(1001) }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("correction_too_long");
  });

  test("returns 404 for unknown answer_id", async () => {
    const r = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: "does-not-exist", correction: "valid text" }),
    });
    expect(r.status).toBe(404);
  });

  test("UPSERT: second submission overwrites the first (latest wins)", async () => {
    const r1 = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, correction: "first version" }),
    });
    expect(r1.status).toBe(200);
    expect((await r1.json())).toEqual({
      ok: true,
      answer_id: ANSWER_1,
      correction: "first version",
      created_at: expect.any(String) as string,
    });
    const r2 = await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_1, correction: "second version" }),
    });
    expect(r2.status).toBe(200);
    expect((await r2.json())).toEqual({
      ok: true,
      answer_id: ANSWER_1,
      correction: "second version",
      created_at: expect.any(String) as string,
    });
    // Verify the row in the DB has the latest value
    const row = srv.dbs.stmts.getFeedbackCorrectionForUid.get(ANSWER_1, UID_A) as { correction: string };
    expect(row.correction).toBe("second version");
  });

  test("each uid has its own correction row for the same answer", async () => {
    await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_A }),
      body: JSON.stringify({ answer_id: ANSWER_2, correction: "UID_A says X" }),
    });
    await fetch(`${srv.url}/v1/feedback/correction`, {
      method: "POST",
      headers: authHeaders(srv.readToken, { "X-Cmms-Uid": UID_B }),
      body: JSON.stringify({ answer_id: ANSWER_2, correction: "UID_B says Y" }),
    });
    const a = srv.dbs.stmts.getFeedbackCorrectionForUid.get(ANSWER_2, UID_A) as { correction: string };
    const b = srv.dbs.stmts.getFeedbackCorrectionForUid.get(ANSWER_2, UID_B) as { correction: string };
    expect(a.correction).toBe("UID_A says X");
    expect(b.correction).toBe("UID_B says Y");
  });
});
