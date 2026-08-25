// Regression test: full ETL must NOT wipe Ask feedback.
//
// Symptom (2026-08-24): every "like" on an assistant answer disappeared
// after a while, and /dashboard/api/feedback/counters returned zeros.
//
// Root cause: runFullEtl() (src/db/etl.ts) starts by calling
// dbs.stmts.clearAll(), and clearAll() executed
//   DELETE FROM feedback_votes;
//   DELETE FROM feedback_corrections;
//   DELETE FROM feedback_answers;
// The feedback_* tables hold runtime user-generated data (Ask votes,
// corrections, saved answers). They are NOT derived from any source
// database, so a full ETL rebuild (triggered by any source-db mtime
// change or restart) permanently destroyed all of them.
//
// Fix: clearAll() now wipes ONLY ETL-derived tables (customers, jobs,
// devices, notes, ticket_cimkek, ticket_problema).
//
// This test seeds both domains, calls stmts.clearAll() (the exact
// call runFullEtl makes), and asserts:
//   - ETL-derived tables ARE cleared (regression guard in the other
//     direction: the wipe must stay complete for what it owns),
//   - feedback_answers / feedback_votes / feedback_corrections
//     survive untouched, and counters still count the surviving votes.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbs } from "../src/db/open";

describe("etl: clearAll preserves Ask feedback", () => {
  let dir: string;
  let cmmsPath: string;
  let specPath: string;

  const ANSWER_ID = "01test-answer-regression";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cmms-etl-fb-"));
    cmmsPath = join(dir, "cmms.db");
    specPath = join(dir, "cmms_specialized.db");
  });

  afterAll(() => {
    // Give the OS a moment to release file locks on Windows.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });

  function seedAll(dbs: ReturnType<typeof openDbs>) {
    // Self-contained: drop any rows left over from sibling tests
    // (the spec DB file persists across tests in this describe).
    dbs.spec.exec("DELETE FROM feedback_votes");
    dbs.spec.exec("DELETE FROM feedback_corrections");
    dbs.spec.exec("DELETE FROM feedback_answers");
    dbs.spec.exec("DELETE FROM notes");
    dbs.spec.exec("DELETE FROM jobs");
    dbs.spec.exec("DELETE FROM customers");

    // --- ETL-derived domain data ---
    dbs.spec
      .prepare("INSERT INTO customers (name, name_ascii) VALUES (?, ?)")
      .run("Teszt Gép Kft.", "teszt gep kft.");
    dbs.spec
      .prepare("INSERT INTO jobs (key, sorszam, reported_at_iso, status) VALUES (?, ?, ?, ?)")
      .run(1, "B26080101", "2026-08-01T08:00:00Z", 0);
    dbs.spec
      .prepare("INSERT INTO notes (job_key, kind, body, body_ascii) VALUES (?, ?, ?, ?)")
      .run(1, "reported", "plc hiba", "plc hiba");

    // --- runtime user-generated feedback data ---
    dbs.spec
      .prepare(
        `INSERT INTO feedback_answers
           (answer_id, q, final_text, tool_trace, model, iterations, language, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(ANSWER_ID, "Melyik céghez történt a legtöbb kiszállás?", "...végleges válasz...", "[]",
           "test-model", 2, "hu", "2026-08-24T10:00:00Z");
    dbs.spec
      .prepare(
        `INSERT INTO feedback_votes (answer_id, uid, vote, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(ANSWER_ID, "uid-regression-1", 1, null, "2026-08-24T10:05:00Z");
    dbs.spec
      .prepare(
        `INSERT INTO feedback_corrections (answer_id, uid, correction, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(ANSWER_ID, "uid-regression-2", "A helyes válasz az ANDRITZ lett volna.", "2026-08-24T10:06:00Z");
  }

  function count(dbs: ReturnType<typeof openDbs>, table: string): number {
    return (dbs.spec.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  test("clearAll clears domain tables but keeps every feedback row", () => {
    const dbs = openDbs({ cmmsPath, specializedPath: specPath });
    try {
      seedAll(dbs);
      expect(count(dbs, "customers")).toBe(1);
      expect(count(dbs, "jobs")).toBe(1);
      expect(count(dbs, "notes")).toBe(1);
      expect(count(dbs, "feedback_answers")).toBe(1);
      expect(count(dbs, "feedback_votes")).toBe(1);
      expect(count(dbs, "feedback_corrections")).toBe(1);

      // This is exactly what runFullEtl() calls first (src/db/etl.ts).
      dbs.stmts.clearAll();

      // ETL-derived tables must still be wiped...
      expect(count(dbs, "customers")).toBe(0);
      expect(count(dbs, "jobs")).toBe(0);
      expect(count(dbs, "notes")).toBe(0);

      // ...but user-generated feedback must survive a rebuild.
      expect(count(dbs, "feedback_answers")).toBe(1);
      expect(count(dbs, "feedback_votes")).toBe(1);
      expect(count(dbs, "feedback_corrections")).toBe(1);
    } finally {
      dbs.spec.close();
    }
  });

  test("counters still see surviving votes after clearAll", () => {
    const dbs = openDbs({ cmmsPath, specializedPath: specPath });
    try {
      seedAll(dbs);
      dbs.stmts.clearAll();

      const counters = dbs.stmts.getFeedbackCounters.get() as {
        likes: number;
        dislikes: number;
      };
      expect(counters.likes).toBe(1);
      expect(counters.dislikes).toBe(0);

      const disliked = dbs.stmts.countDislikedFeedback.get() as { n: number };
      expect(disliked.n).toBe(0); // the seeded vote is a like

      // Vote lookup by (answer_id, uid) still resolves.
      const vote = dbs.stmts.getFeedbackVote.get(ANSWER_ID, "uid-regression-1") as {
        vote: number;
      } | null;
      expect(vote?.vote).toBe(1);
    } finally {
      dbs.spec.close();
    }
  });
});
