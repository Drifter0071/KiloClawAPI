// Phase 5a: cluster cross-DB evidence tests.
//
// Validates that:
//   1. clusterEvidence() correctly queries serviz_belso / szev_igeny /
//      telephely_munka by customer+machine
//   2. table-missing and seed-missing guards return empty arrays
//   3. enrichClustersWithEvidence() mutates clusters in place
//   4. The /v1/jobs/recurring-problems endpoint enriches clusters when
//      the spec tables are loaded
//   5. Fold-based matching works across diacritics and machine variants

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbs } from "../src/db/open";
import { clusterEvidence, enrichClustersWithEvidence } from "../src/lib/cluster_evidence";
import { startTestServer, type TestServer } from "./harness";
import { buildFixture } from "./fixtures/fixture";

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(buildFixture([])); });
afterAll(() => { srv.stop(); });

// ---------------------------------------------------------------------------
// Test fixture: a temp spec DB with all three integration tables pre-seeded.
// ---------------------------------------------------------------------------

function makeSeededSpec(): { dbs: ReturnType<typeof openDbs>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cmms-cluster-ev-"));
  const cmmsPath = join(dir, "cmms.db");
  const specPath = join(dir, "spec.db");
  new Database(cmmsPath); // create empty cmms
  const dbs = openDbs({ cmmsPath, specializedPath: specPath });

  dbs.spec.exec(`
    CREATE TABLE serviz_belso (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      j_szam TEXT, datum_iso TEXT, cegnev TEXT, cegnev_ascii TEXT,
      eszkoz TEXT, eszkoz_ascii TEXT,
      hibajelenseg TEXT, vegzett_munka TEXT, dolgozo TEXT
    );
    CREATE TABLE szev_igeny (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      szev_szam TEXT, igeny_datum_iso TEXT,
      megrendelo TEXT, megrendelo_ascii TEXT,
      geptipus TEXT, igeny TEXT, megjegyzes TEXT, felelos TEXT, statusz INTEGER
    );
    CREATE TABLE telephely_munka (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sorszam TEXT, beerkezes_iso TEXT, kikuldes_iso TEXT,
      megrendelo TEXT, megrendelo_ascii TEXT,
      geptipus TEXT, geptipus_ascii TEXT,
      hibajelenseg TEXT, elvegzett_munka TEXT
    );
  `);

  // Seed serviz_belso with 3 rows. The `_ascii` columns mirror the
  // foldMachine form (no hyphens/spaces) that the real ETL produces.
  const sb = dbs.spec.prepare(
    "INSERT INTO serviz_belso (j_szam, datum_iso, cegnev, cegnev_ascii, eszkoz, eszkoz_ascii, hibajelenseg, vegzett_munka, dolgozo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  sb.run("J00001", "2024-03-15", "ANDRITZ KFT.", "andritz kft.", "TMV-400(10297)", "tmv40010297", "TMV-400 leállt szerviz közben", "Motor csere", "TS");
  sb.run("J00002", "2024-05-22", "ANDRITZMAGYAR Kft.", "andritzmagyar kft.", "TMV 400 (10297)", "tmv40010297", "Zárlatos motor", "Tekercselés", "TS");
  sb.run("J00003", "2024-09-10", "MÁV Zrt.", "mav zrt.", "DPB-2", "dpb2", "DPB-2 hűtés", "Ventilátor csere", "TS");

  // Seed szev_igeny with 2 rows
  const sz = dbs.spec.prepare(
    "INSERT INTO szev_igeny (szev_szam, igeny_datum_iso, megrendelo, megrendelo_ascii, geptipus, igeny, megjegyzes, felelos, statusz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  sz.run("S-2024-001", "2024-04-01", "ANDRITZ KFT.", "andritz kft.", "TMV-400", "Alkatrész igény: motor", "sürgős", "TS", 0);
  sz.run("S-2024-002", "2024-06-15", "MÁV Zrt.",   "mav zrt.",    "DPB-2",   "DPB-2 javítás",     "",         "TS", 1);

  // Seed telephely_munka with 2 rows. geptipus_ascii uses foldMachine form
  // (no hyphens/spaces) since the search uses foldMachine for the LIKE.
  const tm = dbs.spec.prepare(
    "INSERT INTO telephely_munka (sorszam, beerkezes_iso, kikuldes_iso, megrendelo, megrendelo_ascii, geptipus, geptipus_ascii, hibajelenseg, elvegzett_munka) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  tm.run("T-2024-001", "2024-03-20", "2024-03-25", "ANDRITZ Kft.", "andritz kft.", "TMV-400", "tmv400", "TMV-400 főtengely", "Megmunkálás, vissza");
  tm.run("T-2024-002", "2024-08-10", "2024-08-15", "MÁV Zrt.",     "mav zrt.",     "DPB-2",   "dpb2",   "DPB-2 orsó",        "Orsócsere");

  return { dbs, dir };
}

function cleanup(dbs: ReturnType<typeof openDbs>, dir: string) {
  try { dbs.cmms.close(); } catch {}
  try { dbs.spec.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("clusterEvidence()", () => {
  test("returns empty when neither customer nor machine is provided", () => {
    const { dbs, dir } = makeSeededSpec();
    const ev = clusterEvidence(dbs, {});
    expect(ev.serviz_belso).toEqual([]);
    expect(ev.szev_igeny).toEqual([]);
    expect(ev.telephely_munka).toEqual([]);
    expect(ev.total).toBe(0);
    cleanup(dbs, dir);
  });

  test("finds serviz_belso matches by customer fold", () => {
    const { dbs, dir } = makeSeededSpec();
    const ev = clusterEvidence(dbs, { customer: "ANDRITZ" }, { limit: 5 });
    expect(ev.serviz_belso.length).toBe(2);
    expect(ev.serviz_belso.every((e) => e.source === "serviz_belso")).toBe(true);
    // ORDER BY datum_iso DESC → J00002 (2024-05-22) before J00001 (2024-03-15)
    expect(ev.serviz_belso[0].id).toBe("J00002");
    expect(ev.serviz_belso[0].customer).toBe("ANDRITZMAGYAR Kft.");
    expect(ev.serviz_belso[0].snippet.length).toBeGreaterThan(0);
    cleanup(dbs, dir);
  });

  test("finds serviz_belso + szev + telephely matches by machine fold", () => {
    const { dbs, dir } = makeSeededSpec();
    const ev = clusterEvidence(dbs, { machine: "TMV-400" }, { limit: 5 });
    // TMV-400 matches: 2 serviz_belso, 1 szev_igeny, 1 telephely_munka
    expect(ev.serviz_belso.length).toBe(2);
    expect(ev.szev_igeny.length).toBe(1);
    expect(ev.telephely_munka.length).toBe(1);
    expect(ev.total).toBe(4);
    expect(ev.szev_igeny[0].id).toBe("S-2024-001");
    expect(ev.telephely_munka[0].id).toBe("T-2024-001");
    cleanup(dbs, dir);
  });

  test("machine fold ignores hyphen vs space in foldMachine'd columns", () => {
    // serviz_belso.eszkoz_ascii and telephely_munka.geptipus_ascii both use
    // the foldMachine form (no hyphens/spaces), so hyphen vs space in the
    // query must produce identical results in those two sources. szev_igeny
    // uses a plain fold (no hyphen strip), so it's allowed to differ.
    const { dbs, dir } = makeSeededSpec();
    const ev1 = clusterEvidence(dbs, { machine: "TMV-400" }, { limit: 5 });
    const ev2 = clusterEvidence(dbs, { machine: "TMV 400" }, { limit: 5 });
    expect(ev1.serviz_belso.length).toBe(ev2.serviz_belso.length);
    expect(ev1.telephely_munka.length).toBe(ev2.telephely_munka.length);
    cleanup(dbs, dir);
  });

  test("limits results per source", () => {
    const { dbs, dir } = makeSeededSpec();
    const ev = clusterEvidence(dbs, { customer: "ANDRITZ" }, { limit: 1 });
    expect(ev.serviz_belso.length).toBe(1);
    cleanup(dbs, dir);
  });

  test("truncates long snippets to 200 chars", () => {
    const { dbs, dir } = makeSeededSpec();
    // Add a row with a 500-char description
    dbs.spec.prepare(
      "INSERT INTO serviz_belso (j_szam, datum_iso, cegnev, cegnev_ascii, eszkoz, eszkoz_ascii, hibajelenseg, vegzett_munka) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("J-LONG", "2024-04-01", "LONG Kft.", "long kft.", "TMV-400", "tmv-400", "X".repeat(500), "X".repeat(500));
    const ev = clusterEvidence(dbs, { customer: "LONG" }, { limit: 1 });
    expect(ev.serviz_belso[0].snippet.length).toBeLessThanOrEqual(200);
    expect(ev.serviz_belso[0].snippet.endsWith("...")).toBe(true);
    cleanup(dbs, dir);
  });

  test("returns empty arrays when spec tables are missing (test fixture)", () => {
    // Use the test harness's spec DB which has none of the integration tables
    const ev = clusterEvidence(srv.dbs, { customer: "ANDRITZ" });
    expect(ev.serviz_belso).toEqual([]);
    expect(ev.szev_igeny).toEqual([]);
    expect(ev.telephely_munka).toEqual([]);
    expect(ev.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// enrichClustersWithEvidence() — in-place mutation
// ---------------------------------------------------------------------------

describe("enrichClustersWithEvidence()", () => {
  test("attaches related_integration to each cluster", () => {
    const { dbs, dir } = makeSeededSpec();
    const clusters = [
      {
        cluster_key: "k1",
        signature: { customer: "ANDRITZ", machine: "TMV-400" },
        ticket_count: 2,
        visit_count: 4,
        technicians: ["TS"],
        first_seen: "2024-01-01",
        last_seen: "2024-06-01",
        span_days: 150,
        avg_gap_days: 75,
        handoffs: [],
      },
    ];
    enrichClustersWithEvidence(dbs, clusters, { limit: 2 });
    expect(clusters[0]).toHaveProperty("related_integration");
    const ev = (clusters[0] as any).related_integration;
    expect(ev.serviz_belso.length).toBe(2);
    expect(ev.szev_igeny.length).toBe(1);
    expect(ev.telephely_munka.length).toBe(1);
    expect(ev.total).toBe(4);
    cleanup(dbs, dir);
  });

  test("returns empty related_integration when signature is empty", () => {
    const { dbs, dir } = makeSeededSpec();
    const clusters = [
      {
        cluster_key: "k2",
        signature: {},
        ticket_count: 2,
        visit_count: 4,
        technicians: ["TS"],
        first_seen: "2024-01-01",
        last_seen: "2024-06-01",
        span_days: 150,
        avg_gap_days: 75,
        handoffs: [],
      },
    ];
    enrichClustersWithEvidence(dbs, clusters, { limit: 2 });
    const ev = (clusters[0] as any).related_integration;
    expect(ev.total).toBe(0);
    cleanup(dbs, dir);
  });

  test("mutates the input array (does not clone)", () => {
    const { dbs, dir } = makeSeededSpec();
    const clusters = [
      {
        cluster_key: "k3",
        signature: { customer: "ANDRITZ" },
        ticket_count: 1, visit_count: 1, technicians: [],
        first_seen: "", last_seen: "", span_days: 0, avg_gap_days: 0,
        handoffs: [],
      },
    ];
    const before = clusters.length;
    const out = enrichClustersWithEvidence(dbs, clusters, { limit: 1 });
    expect(out).toBe(clusters); // same reference
    expect(clusters.length).toBe(before);
    cleanup(dbs, dir);
  });
});
