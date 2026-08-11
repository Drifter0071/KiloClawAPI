// Phase 5b: ticket-linkage scanner tests.
//
// Validates:
//   1. The regex catches the three real-world sorszam formats
//      (B-2024/0891, B2408001, B-20240891) and ignores false positives
//      (phone numbers, firmware versions, etc.)
//   2. Catalog validation drops non-existent sorszams
//   3. Forward/reverse indices are built correctly
//   4. The cache's referencedBy / referencesOf / topHubs work
//   5. /v1/jobs/linkage returns the right shape for each direction
//
// Hungarian sorszam key names appear in the test data below; we
// declare them as plain ASCII (SORSZAM, CEGNEV) instead of the
// real Hungarian column names to keep the file encoding safe.
// The schema is unchanged.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbs } from "../src/db/open";
import { JobCache } from "../src/cache/jobs";
import { buildLinkageIndex, referencedBy, referencesOf } from "../src/lib/linkage";
import { startTestServer, type TestServer } from "./harness";
import { buildFixture } from "./fixtures/fixture";

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(buildFixture([])); });
afterAll(() => { srv.stop(); });

// ---------------------------------------------------------------------------
// Synthetic cache builder. Seeds the spec DB directly (no full ETL) so
// the test doesn't need a populated cmms.db data table.
// ---------------------------------------------------------------------------

type LinkageRow = {
  key: number;
  sorszam: string;
  date: string;
  customer: string;
  reported?: string;
  work?: string;
};

function mkCache(rows: LinkageRow[]) {
  const dir = mkdtempSync(join(tmpdir(), "cmms-link-"));
  const cmmsPath = join(dir, "cmms.db");
  const specPath = join(dir, "spec.db");
  new Database(cmmsPath);
  const dbs = openDbs({ cmmsPath, specializedPath: specPath });
  for (const r of rows) {
    dbs.spec.prepare(
      `INSERT OR REPLACE INTO customers (id, name, name_ascii) VALUES (?, ?, ?)`,
    ).run(r.key, r.customer, r.customer.toLowerCase());
    dbs.spec.prepare(
      `INSERT OR REPLACE INTO jobs (
        key, sorszam, reported_at, reported_at_iso, customer_id, technician, status,
        problem_kategoria, problem_alkategoria, sulyossag,
        kategoria_inferred, kategoria_inferred_conf,
        sulyossag_inferred, sulyossag_inferred_conf,
        alkategoria_inferred, resolution
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.key, r.sorszam, r.date, r.date, r.key, null, 1,
      null, null, null, null, null, null, null, null, "open",
    );
    if (r.reported) {
      dbs.spec.prepare(
        `INSERT INTO notes (job_key, kind, body, body_ascii, author, created_at)
         VALUES (?, 'reported', ?, ?, NULL, ?)`,
      ).run(r.key, r.reported, r.reported.toLowerCase(), r.date);
    }
    if (r.work) {
      dbs.spec.prepare(
        `INSERT INTO notes (job_key, kind, body, body_ascii, author, created_at)
         VALUES (?, 'work', ?, ?, NULL, ?)`,
      ).run(r.key, r.work, r.work.toLowerCase(), r.date);
    }
  }
  try { dbs.spec.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
  const cache = new JobCache();
  cache.buildFromDb(dbs);
  return { cache, dbs, dir };
}

function cleanup(dbs: ReturnType<typeof openDbs>, dir: string) {
  try { dbs.cmms.close(); } catch {}
  try { dbs.spec.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

// ---------------------------------------------------------------------------
// 1. buildLinkageIndex
// ---------------------------------------------------------------------------

describe("buildLinkageIndex()", () => {
  test("finds slashed-format sorszam references (B-2024/0891)", () => {
    const { cache, dbs, dir } = mkCache([
      { key: 1, sorszam: "B-2024/0891", date: "2024-08-15", customer: "ANDRITZ KFT.", reported: "TMV-400 motor leallt" },
      { key: 2, sorszam: "B-2024/0892", date: "2024-08-22", customer: "ANDRITZ KFT.", reported: "lasd B-2024/0891" },
      { key: 3, sorszam: "B-2024/0893", date: "2024-09-01", customer: "ANDRITZ KFT.", work: "B-2024/0891 follow-up" },
    ]);
    const idx = buildLinkageIndex(cache);
    expect(referencedBy(idx, "B-2024/0891").length).toBe(2);
    expect(referencesOf(idx, "B-2024/0892").length).toBe(1);
    expect(idx.total).toBeGreaterThanOrEqual(2);
    cleanup(dbs, dir);
  });

  test("finds compact sorszam format (B2408001)", () => {
    const { cache, dbs, dir } = mkCache([
      { key: 1, sorszam: "B2408001", date: "2024-08-15", customer: "MAV", reported: "TMV-400 motor leallt" },
      { key: 2, sorszam: "B2408002", date: "2024-08-22", customer: "MAV", reported: "lasd B2408001" },
    ]);
    const idx = buildLinkageIndex(cache);
    expect(referencedBy(idx, "B2408001").length).toBe(1);
    cleanup(dbs, dir);
  });

  test("catalog validation drops false positives (phone numbers, firmware)", () => {
    const { cache, dbs, dir } = mkCache([
      { key: 1, sorszam: "B2408001", date: "2024-08-15", customer: "X Kft.", reported: "TMV-400 motor leallt" },
      { key: 2, sorszam: "B2408002", date: "2024-08-22", customer: "X Kft.", reported: "Phone: 06-30-555-1234, FW: SW-2.001, see B-2024/9999 (does not exist)" },
    ]);
    const idx = buildLinkageIndex(cache);
    // B-2024/9999 is in the body but not in the catalog -> dropped.
    expect(referencedBy(idx, "B2408001").length).toBe(0);
    expect(idx.total).toBe(0);
    cleanup(dbs, dir);
  });

  test("self-references are dropped", () => {
    const { cache, dbs, dir } = mkCache([
      { key: 1, sorszam: "B2408001", date: "2024-08-15", customer: "X Kft.", reported: "lasd B-2024/0891-et (this is me, sort of)" },
    ]);
    const idx = buildLinkageIndex(cache);
    // B-2024/0891 isn't in catalog -> no link.
    expect(idx.total).toBe(0);
    cleanup(dbs, dir);
  });

  test("no notes -> empty index", () => {
    const { cache, dbs, dir } = mkCache([
      { key: 1, sorszam: "B2408001", date: "2024-08-15", customer: "X Kft." },
    ]);
    const idx = buildLinkageIndex(cache);
    expect(idx.total).toBe(0);
    expect(idx.forward.size).toBe(0);
    cleanup(dbs, dir);
  });
});

// ---------------------------------------------------------------------------
// 2. JobCache integration
// ---------------------------------------------------------------------------

describe("JobCache linkage methods", () => {
  test("topHubs ranks tickets by indegree", () => {
    const { cache, dbs, dir } = mkCache([
      { key: 1, sorszam: "B2408001", date: "2024-01-15", customer: "A Kft.", reported: "TMV-400 motor hiba" },
      { key: 2, sorszam: "B2408002", date: "2024-01-22", customer: "A Kft.", reported: "lasd B2408001" },
      { key: 3, sorszam: "B2408003", date: "2024-01-29", customer: "A Kft.", reported: "B2408001 folytatasa" },
      { key: 4, sorszam: "B2408004", date: "2024-02-05", customer: "A Kft.", work: "B2408001 lezaras" },
    ]);
    const hubs = cache.topHubs({ limit: 5, include_samples: 3 });
    expect(hubs.length).toBeGreaterThan(0);
    expect(hubs[0].sorszam).toBe("B2408001");
    expect(hubs[0].referenced_by_count).toBe(3);
    expect(hubs[0].customer).toBe("A Kft.");
    expect(hubs[0].sample_referenced_by.length).toBe(3);
    cleanup(dbs, dir);
  });

  test("topHubs returns empty list when no references exist", () => {
    const { cache, dbs, dir } = mkCache([
      { key: 1, sorszam: "B2408001", date: "2024-01-15", customer: "X Kft.", reported: "standalone issue" },
      { key: 2, sorszam: "B2408002", date: "2024-01-22", customer: "X Kft.", reported: "another standalone" },
    ]);
    const hubs = cache.topHubs({ limit: 5 });
    expect(hubs.length).toBe(0);
    cleanup(dbs, dir);
  });

  test("referencedBy / referencesOf return empty for unknown sorszam", () => {
    const { cache, dbs, dir } = mkCache([
      { key: 1, sorszam: "B2408001", date: "2024-01-15", customer: "X Kft." },
    ]);
    expect(cache.referencedBy("B9999999").length).toBe(0);
    expect(cache.referencesOf("B9999999").length).toBe(0);
    cleanup(dbs, dir);
  });
});

// ---------------------------------------------------------------------------
// 3. REST endpoint /v1/jobs/linkage
// ---------------------------------------------------------------------------

describe("GET /v1/jobs/linkage", () => {
  test("direction=stats returns total_refs", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/linkage?direction=stats`, {
      headers: { authorization: `Bearer ${srv.readToken}` },
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.direction).toBe("stats");
    expect(typeof j.total_refs).toBe("number");
  });

  test("direction=top_hubs returns hubs array", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/linkage?direction=top_hubs&limit=5`, {
      headers: { authorization: `Bearer ${srv.readToken}` },
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.direction).toBe("top_hubs");
    expect(Array.isArray(j.hubs)).toBe(true);
    expect(j.total).toBe(j.hubs.length);
  });

  test("direction=referenced_by requires sorszam", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/linkage?direction=referenced_by`, {
      headers: { authorization: `Bearer ${srv.readToken}` },
    });
    expect(r.status).toBe(400);
  });

  test("direction=referenced_by returns refs for a known sorszam", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/linkage?direction=referenced_by&sorszam=B20010101`, {
      headers: { authorization: `Bearer ${srv.readToken}` },
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.direction).toBe("referenced_by");
    expect(j.sorszam).toBe("B20010101");
    expect(Array.isArray(j.refs)).toBe(true);
  });

  test("direction=references returns refs for a known sorszam", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/linkage?direction=references&sorszam=B20010101`, {
      headers: { authorization: `Bearer ${srv.readToken}` },
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.direction).toBe("references");
    expect(Array.isArray(j.refs)).toBe(true);
  });

  test("invalid direction returns 400", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/linkage?direction=bogus`, {
      headers: { authorization: `Bearer ${srv.readToken}` },
    });
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 4. Router
// ---------------------------------------------------------------------------

describe("router: top_hubs intent", () => {
  test("'melyik munkahoz jartunk ki a legtobbszor?' routes to top_hubs", async () => {
    const r = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${srv.readToken}`, "content-type": "application/json" },
      body: JSON.stringify({ q: "melyik munkahoz jartunk ki a legtobbszor?" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.intent).toBe("top_hubs");
    expect(j.primitive).toBe("top_hubs");
    expect(Array.isArray(j.results)).toBe(true);
  });

  test("'which work order had the most references?' routes to top_hubs", async () => {
    const r = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${srv.readToken}`, "content-type": "application/json" },
      body: JSON.stringify({ q: "which work order had the most references?" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.intent).toBe("top_hubs");
  });
});
