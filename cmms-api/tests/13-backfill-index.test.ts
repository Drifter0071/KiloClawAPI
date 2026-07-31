// Regression test for the Phase 1 production hang.
//
// Symptom: cmms-api hung for 25+ minutes in the Phase 1 backfill
// after a restart, even though the inferred columns were already
// populated. Root cause: the backfill's correlated subquery on
// notes (SELECT body FROM notes WHERE job_key = ? AND kind = ?
// ORDER BY id LIMIT 1) had no supporting index, so SQLite did a
// full table scan per row per subquery. 65k jobs * 2 subqueries *
// 100k notes = 13B row reads.
//
// Fix:
//   1. open.ts now creates idx_notes_job_key_kind on notes(job_key, kind).
//   2. backfill.ts now has a "smart skip": if 99% of jobs already have
//      kategoria_inferred populated, it sets the _meta flag and returns
//      without doing the heavy work.
//
// This test verifies both pieces. We use a 3-row fixture (a job
// with reported + work notes, a job with only a reported note, a
// job with only a work note) and force a backfill on a DB that
// already has the data, then time the second call.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbs } from "../src/db/open";
import { runPhase1BackfillIfNeeded } from "../src/db/backfill";

function seedSpecDb(spec: Database) {
  spec.exec("DELETE FROM jobs;");
  // Insert 3 jobs with different note layouts.
  spec.prepare(
    "INSERT INTO jobs (key, sorszam, reported_at_iso, status, kategoria_inferred, sulyossag_inferred) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(1, "B26010101", "2026-01-01T08:00:00Z", 0, "Egyeb", "kozepes");
  spec.prepare(
    "INSERT INTO jobs (key, sorszam, reported_at_iso, status, kategoria_inferred, sulyossag_inferred) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(2, "B26010102", "2026-01-01T09:00:00Z", 0, "Egyeb", "kozepes");
  spec.prepare(
    "INSERT INTO jobs (key, sorszam, reported_at_iso, status, kategoria_inferred, sulyossag_inferred) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(3, "B26010103", "2026-01-01T10:00:00Z", 0, "Egyeb", "kozepes");
  // Job 1: reported + work
  spec.prepare("INSERT INTO notes (job_key, kind, body, body_ascii) VALUES (?, ?, ?, ?)")
    .run(1, "reported", "plc program hiba", "plc program hiba");
  spec.prepare("INSERT INTO notes (job_key, kind, body, body_ascii) VALUES (?, ?, ?, ?)")
    .run(1, "work", "paramétert átírtam", "parametert atirtam");
  // Job 2: reported only
  spec.prepare("INSERT INTO notes (job_key, kind, body, body_ascii) VALUES (?, ?, ?, ?)")
    .run(2, "reported", "szervo motor csere", "szervo motor csere");
  // Job 3: work only
  spec.prepare("INSERT INTO notes (job_key, kind, body, body_ascii) VALUES (?, ?, ?, ?)")
    .run(3, "work", "kijelzo sotet volt", "kijelzo sotet volt");
}

describe("backfill: index + smart skip", () => {
  let dir: string;
  let cmmsPath: string;
  let specPath: string;
  let cmmsHandle: Database;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cmms-bf-"));
    cmmsPath = join(dir, "cmms.db");
    specPath = join(dir, "cmms_specialized.db");
    cmmsHandle = new Database(cmmsPath); // create empty
  });

  afterAll(() => {
    try { cmmsHandle?.close(); } catch {}
    // Give the OS a moment to release file locks on Windows.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });

  test("idx_notes_job_kind exists after openDbs", () => {
    const dbs = openDbs({ cmmsPath, specializedPath: specPath });
    try {
      const idx = dbs.spec
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notes_job_kind'")
        .get();
      expect(idx).toBeTruthy();
    } finally {
      dbs.spec.close();
    }
  });

  test("smart skip: pre-classified data is recognized, flag is set, second call is fast", () => {
    const dbs = openDbs({ cmmsPath, specializedPath: specPath });
    try {
      seedSpecDb(dbs.spec);
      // Data is already classified. The flag is NOT set yet. The first
      // call should detect 99% coverage and skip without classifying.
      const flagBefore = dbs.spec.prepare("SELECT value FROM _meta WHERE key='phase1_backfill_done'").get();
      expect(flagBefore).toBeNull();

      const r1 = runPhase1BackfillIfNeeded(dbs);
      expect(r1.ran).toBe(false);
      expect(r1.classified).toBe(0);

      const flagAfter = dbs.spec.prepare("SELECT value FROM _meta WHERE key='phase1_backfill_done'").get() as { value: string };
      expect(flagAfter?.value).toBe("1");

      // Second call is O(1) thanks to the flag.
      const t0 = performance.now();
      const r2 = runPhase1BackfillIfNeeded(dbs);
      const ms = performance.now() - t0;
      expect(r2.ran).toBe(false);
      expect(r2.classified).toBe(0);
      expect(ms).toBeLessThan(50); // microsecond range
    } finally {
      dbs.spec.close();
    }
  });

  test("backfill: classifies uncategorized rows and sets the flag", () => {
    const specPath2 = join(dir, "cmms_spec2.db");
    const dbs = openDbs({ cmmsPath, specializedPath: specPath2 });
    try {
      // Drop the kategoria_inferred values to simulate a fresh DB.
      seedSpecDb(dbs.spec);
      dbs.spec.prepare("UPDATE jobs SET kategoria_inferred = NULL, sulyossag_inferred = NULL").run();

      const r = runPhase1BackfillIfNeeded(dbs);
      expect(r.ran).toBe(true);
      expect(r.classified).toBe(3);
      // Job 1: "plc program hiba" reported + "kijelző sotet" work -> mixed, but
      //         kategoria "Szoftver/PLC program hiba" wins on reported text.
      // Job 2: "szervo motor csere" -> Szervo / hajtas
      // Job 3: "kijelzo sotet" -> Kijelzo / HMI
      expect(r.by_kategoria["Szoftver/PLC program hiba"]).toBeGreaterThanOrEqual(1);
      expect(r.by_kategoria["Szervo / hajtas hiba"]).toBeGreaterThanOrEqual(1);
      expect(r.by_kategoria["Kijelzo / HMI"]).toBeGreaterThanOrEqual(1);

      // Flag is now set.
      const flag = dbs.spec.prepare("SELECT value FROM _meta WHERE key='phase1_backfill_done'").get() as { value: string };
      expect(flag?.value).toBe("1");
    } finally {
      dbs.spec.close();
    }
  });
});
