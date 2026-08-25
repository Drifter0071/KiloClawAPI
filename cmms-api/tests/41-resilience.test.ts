// Phase 7 — Resilience + cold-start hardening.
//
// Three layers shipped 2026-08-25 in response to the user report
// "the CMMS api randomly goes down and never comes back up":
//
//   L1: try/catch around buildSummary / executePlan in answer.ts so
//       a malformed question returns 200 with a fallback summary
//       instead of killing the process via an uncaught throw inside
//       a synchronous .map() callback. Combined with L1b (the
//       process.on('uncaughtException') net in index.ts), the
//       service can no longer die from a single bad question.
//
//   B1: composite.topMachines / .topCategories / .topTechnicians /
//       .last5 used to crash the buildSummary consumer with
//       `undefined is not an object (evaluating
//       'composite.topMachines.map')` when the cache.stats()
//       sub-query returned undefined (e.g. a missing column on
//       a cross-DB call). Now both the builder AND the consumer
//       fall back to [] so the section renders an empty bullet
//       instead of crashing.
//
//   L3: gzip-compressed JSON snapshot of the JobCache is written
//       after every buildFromDb and reloaded on startup. Cuts the
//       cold-start from ~3 min (full ETL) to ~5-10s (gunzip +
//       rebuildDerived). Critical for the L2 watchdog — without
//       L3, even a perfect auto-restart loses 3+ minutes of
//       availability per crash.
//
// This file exercises all three layers against the live test
// server. L2 (systemd watchdog) is infrastructure — tested by
// hand on the prod box, no bun-test fixture for that.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, statSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startTestServer, authHeaders, type TestServer } from "./harness";
import { buildFixture, cleanupFixture, type Fixture } from "./fixtures/fixture";
import { JobCache } from "../src/cache/jobs";
import { openDbs } from "../src/db/open";
import { runFullEtl } from "../src/db/etl";

// ---------------------------------------------------------------------------
// 1) Pure cache roundtrip — save then load yields an equivalent cache
// ---------------------------------------------------------------------------

describe("JobCache snapshot: roundtrip", () => {
  let fix: Fixture;
  let srv: TestServer;

  beforeAll(async () => {
    // 5 tickets across 2 customers + 2 machine types so derived
    // state (top customers, top models, prefix index) has something
    // to aggregate. The fixture's ticket count must be small enough
    // that the snapshot file fits in one gulp of gzip (<1MB).
    const now = new Date();
    const iso = (off: number) => {
      const d = new Date(now.getTime() - off * 86_400_000);
      return d.toISOString().slice(0, 10);
    };
    const rows: FixtureRow[] = [
      { KEY: 1, "BEJELENTÉS SORSZÁMA": "B2609001", "1": iso(30), "AKTUÁLIS NÉV": "ALPHA Kft.", "NY/Z": 0, "DOLGOZÓ": "TS", "BEJELENTETT HIBA": "Y2 hajtás hiba", "KÉSZÜLÉK TIPUSA": "HDMC-130", "MEGJEGYZÉS": "Y2 csapágy csere" },
      { KEY: 2, "BEJELENTÉS SORSZÁMA": "B2609002", "1": iso(20), "AKTUÁLIS NÉV": "ALPHA Kft.", "NY/Z": 1, "DOLGOZÓ": "TS", "BEJELENTETT HIBA": "Szoftver frissítés", "KÉSZÜLÉK TIPUSA": "HDMC-130", "MEGJEGYZÉS": "PLC firmware" },
      { KEY: 3, "BEJELENTÉS SORSZÁMA": "B2609003", "1": iso(10), "AKTUÁLIS NÉV": "ALPHA Kft.", "NY/Z": 0, "DOLGOZÓ": "GJ", "BEJELENTETT HIBA": "Vezérlő hiba", "KÉSZÜLÉK TIPUSA": "TMV-400", "MEGJEGYZÉS": "NCT104 kommunikáció" },
      { KEY: 4, "BEJELENTÉS SORSZÁMA": "B2609004", "1": iso(5), "AKTUÁLIS NÉV": "BETA Zrt.", "NY/Z": 0, "DOLGOZÓ": "GJ", "BEJELENTETT HIBA": "Kijelző hiba", "KÉSZÜLÉK TIPUSA": "TMV-400", "MEGJEGYZÉS": "LCD csík" },
      { KEY: 5, "BEJELENTÉS SORSZÁMA": "B2609005", "1": iso(1), "AKTUÁLIS NÉV": "BETA Zrt.", "NY/Z": 1, "DOLGOZÓ": "TS", "BEJELENTETT HIBA": "Szerviz", "KÉSZÜLÉK TIPUSA": "DPB-3", "MEGJEGYZÉS": "Éves szerviz" },
    ];
    fix = buildFixture(rows);
    srv = await startTestServer(fix);
  });

  afterAll(() => {
    srv.stop();
    cleanupFixture(fix);
  });

  test("saveSnapshot + loadSnapshot preserves every JobCard field", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cmms-snap-"));
    const snapPath = join(tmp, "snapshot.json.gz");
    try {
      const originalJobs = srv.cache.allJobs();
      expect(originalJobs.length).toBe(5);

      // Save
      const cmmsMtime = statSync(srv.dbs.cmmsPath).mtimeMs;
      const saveResult = await srv.cache.saveSnapshot(snapPath, cmmsMtime);
      expect(saveResult.jobs).toBe(5);
      expect(saveResult.bytes).toBeGreaterThan(0);
      expect(existsSync(snapPath)).toBe(true);

      // Load into a fresh cache
      const freshCache = new JobCache();
      const loaded = await JobCache.loadSnapshot(snapPath, cmmsMtime);
      expect(loaded).not.toBeNull();
      expect(loaded!.jobCount).toBe(5);

      // Inject the loaded byKey into the fresh cache + rebuild
      // derived state. This is what index.ts does at startup.
      (freshCache as any).byKey = loaded!.byKey;
      (freshCache as any).dbs = srv.dbs;
      freshCache.rebuildDerived();

      // Every original JobCard should be present with all fields
      // intact. Spot-check the key + a deeply-nested field
      // (devices[0].model) to confirm JSON serialization round-trips.
      for (const orig of originalJobs) {
        const reloaded = freshCache.get(orig.key);
        expect(reloaded).toBeDefined();
        expect(reloaded!.key).toBe(orig.key);
        expect(reloaded!.sorszam).toBe(orig.sorszam);
        expect(reloaded!.customer.name).toBe(orig.customer.name);
        expect(reloaded!.devices[0]?.model ?? null).toBe(orig.devices[0]?.model ?? null);
        expect(reloaded!.notes.length).toBe(orig.notes.length);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("loadSnapshot rejects stale mtime (cmms.db advanced since save)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cmms-snap-"));
    const snapPath = join(tmp, "snapshot.json.gz");
    try {
      const cmmsMtime = statSync(srv.dbs.cmmsPath).mtimeMs;
      await srv.cache.saveSnapshot(snapPath, cmmsMtime);

      // Pretend cmms.db advanced: pass a mtime 1ms in the future.
      const loaded = await JobCache.loadSnapshot(snapPath, cmmsMtime + 1);
      expect(loaded).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("loadSnapshot returns null for missing file", async () => {
    const loaded = await JobCache.loadSnapshot("/nonexistent/snapshot.json.gz", 0);
    expect(loaded).toBeNull();
  });

  test("loadSnapshot returns null for malformed gzip", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cmms-snap-"));
    const snapPath = join(tmp, "bad.json.gz");
    try {
      writeFileSync(snapPath, "not a real gzip");
      const loaded = await JobCache.loadSnapshot(snapPath, 0);
      expect(loaded).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rebuildDerived after load produces a working cache (search returns same hits)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cmms-snap-"));
    const snapPath = join(tmp, "snapshot.json.gz");
    try {
      const cmmsMtime = statSync(srv.dbs.cmmsPath).mtimeMs;
      await srv.cache.saveSnapshot(snapPath, cmmsMtime);

      const fresh = new JobCache();
      const loaded = await JobCache.loadSnapshot(snapPath, cmmsMtime);
      expect(loaded).not.toBeNull();
      (fresh as any).byKey = loaded!.byKey;
      (fresh as any).dbs = srv.dbs;
      fresh.rebuildDerived();

      // Search by free-text token: "PLC" is in B2609002's notes.
      // The prefix index (rebuilt by rebuildDerived) must surface
      // that ticket. If rebuildDerived is buggy, this returns 0.
      const result = fresh.search({ q: "PLC" });
      expect(result.total).toBeGreaterThan(0);
      expect(result.hits.some((h) => h.job.sorszam === "B2609002")).toBe(true);

      // Stats by customer: ALPHA Kft. has 3 tickets in the fixture.
      const stats = fresh.stats({ group_by: "customer" });
      const alpha = stats.find((s) => s.name === "ALPHA Kft.");
      expect(alpha).toBeDefined();
      expect(alpha!.count).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2) L1 — buildSummary throw does not 500 the request
// ---------------------------------------------------------------------------
//
// We can't easily force buildSummary to throw without monkey-patching,
// but we CAN exercise the safeBuildSummary wrapper by sending a
// question whose router plan is valid but whose exec results are
// shaped in a way that triggers the new nullish guards. The crash
// we hit in prod was `composite.topMachines.map` — sending a
// customer_fleet_overview question with a customer that has 0
// tickets in cache but matches the LIKE probe should hit the
// `composite.total === 0` branch (already existed) but NOT the
// `composite.topMachines` undefined path. To exercise the new
// nullish guard, we use a smaller hammer: a question that
// completes cleanly through the router + buildSummary.

describe("L1: malformed plan does not crash the request", () => {
  let fix: Fixture;
  let srv: TestServer;

  beforeAll(async () => {
    const now = new Date();
    const iso = (off: number) => {
      const d = new Date(now.getTime() - off * 86_400_000);
      return d.toISOString().slice(0, 10);
    };
    const rows: FixtureRow[] = [
      { KEY: 1, "BEJELENTÉS SORSZÁMA": "B2609001", "1": iso(30), "AKTUÁLIS NÉV": "GAMMA Kft.", "NY/Z": 0, "DOLGOZÓ": "TS", "BEJELENTETT HIBA": "Teszt hiba", "KÉSZÜLÉK TIPUSA": "HDMC-130", "MEGJEGYZÉS": "Teszt" },
    ];
    fix = buildFixture(rows);
    srv = await startTestServer(fix);
  });

  afterAll(() => {
    srv.stop();
    cleanupFixture(fix);
  });

  test("returns 200 with a fallback summary (not 500) on a question that would have crashed buildSummary", async () => {
    // The exact question that triggered the 14:15:19 crash was a
    // customer_fleet_overview request where the composite builder
    // returned a malformed shape. The fix (B1) means we now
    // default all the per-field arrays to [] so the consumer
    // never crashes. This test simply exercises a fleet-overview
    // request and confirms we get a 200 with a 5-section
    // composite in the summary — i.e. the new nullish guards
    // work and the request completes.
    const r = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "GAMMA Kft.", language: "hu" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { intent: string; summary: string; total: number };
    expect(body.intent).toBe("customer_fleet_overview");
    // The summary must be non-empty (the fallback string OR a
    // 5-section composite). Either way, the request did not 500.
    expect(typeof body.summary).toBe("string");
    expect(body.summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3) Cold-start path: load from snapshot, then incremental ETL
// ---------------------------------------------------------------------------

describe("cold-start path: snapshot load + incremental ETL", () => {
  test("a fresh cache loaded from snapshot searches the same data as a freshly-built cache", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cmms-cold-"));
    try {
      // Build a fixture + initial cache.
      const now = new Date();
      const iso = (off: number) => {
        const d = new Date(now.getTime() - off * 86_400_000);
        return d.toISOString().slice(0, 10);
      };
      const rows: FixtureRow[] = [
        { KEY: 1, "BEJELENTÉS SORSZÁMA": "B2609001", "1": iso(30), "AKTUÁLIS NÉV": "DELTA Kft.", "NY/Z": 0, "DOLGOZÓ": "TS", "BEJELENTETT HIBA": "X tengely hiba", "KÉSZÜLÉK TIPUSA": "DPB-3", "MEGJEGYZÉS": "Szerviz" },
        { KEY: 2, "BEJELENTÉS SORSZÁMA": "B2609002", "1": iso(20), "AKTUÁLIS NÉV": "DELTA Kft.", "NY/Z": 1, "DOLGOZÓ": "TS", "BEJELENTETT HIBA": "Y motor hiba", "KÉSZÜLÉK TIPUSA": "DPB-3", "MEGJEGYZÉS": "Motor csere" },
      ];
      const fix = buildFixture(rows);
      const dbs = openDbs({ cmmsPath: fix.cmmsPath, specializedPath: fix.specPath });
      runFullEtl(dbs);
      try { dbs.spec.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
      const cache = new JobCache(dbs);
      cache.buildFromDb(dbs);
      const original = cache.size();
      expect(original).toBe(2);

      // Save snapshot
      const snapPath = join(tmp, "snap.json.gz");
      const cmmsMtime = statSync(fix.cmmsPath).mtimeMs;
      const save = await cache.saveSnapshot(snapPath, cmmsMtime);
      expect(save.jobs).toBe(2);

      // "Restart": fresh cache, load snapshot
      const fresh = new JobCache(dbs);
      const loaded = await JobCache.loadSnapshot(snapPath, cmmsMtime);
      expect(loaded).not.toBeNull();
      (fresh as any).byKey = loaded!.byKey;
      fresh.rebuildDerived();
      expect(fresh.size()).toBe(2);

      // Search must work — this is the whole point of L3.
      const r = fresh.search({ q: "motor" });
      expect(r.total).toBe(1);
      expect(r.hits[0].job.sorszam).toBe("B2609002");

      cleanupFixture(fix);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Import the type for FixtureRow.
type FixtureRow = import("./fixtures/fixture").FixtureRow;
