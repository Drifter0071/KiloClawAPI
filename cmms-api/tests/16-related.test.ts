// Phase 4 tests: find_related_tickets — cross-database timeline.
//
// Tests the /v1/related REST endpoint, the findRelated() function directly,
// and the router's find_related intent classification.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbs } from "../src/db/open";
import { JobCache } from "../src/cache/jobs";
import { findRelated } from "../src/lib/related";
import { routeQuestion } from "../src/lib/router";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";
import { startTestServer, type TestServer } from "./harness";

// ---------------------------------------------------------------------------
// Fixture: 5 tickets for the same customer + device at different dates,
// plus 1 unrelated ticket.
// ---------------------------------------------------------------------------

const rows: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B24010101",
    "1": "2024.01.15",
    "AKTUÁLIS NÉV": "ANDRITZ KFT.",
    "KÉSZÜLÉK TIPUSA": "DPB-2(10297;M10170);NCT104;SW-1.039;",
    "BEJELENTETT HIBA": "szoftver hiba, PLC nem válaszol",
    "ELVÉGZETT MUNKA": "újraindítás, firmware frissítés",
    "NY/Z": 0, // closed
    "DOLGOZÓ": "KP;",
  },
  {
    KEY: 2,
    "BEJELENTÉS SORSZÁMA": "B24020201",
    "1": "2024.02.20",
    "AKTUÁLIS NÉV": "ANDRITZ KFT.",
    "KÉSZÜLÉK TIPUSA": "DPB-2(10297;M10170);NCT104;SW-1.039;",
    "BEJELENTETT HIBA": "újra jelentkező szoftver hiba",
    "ELVÉGZETT MUNKA": "PLC csere",
    "NY/Z": 0, // closed
    "DOLGOZÓ": "TP;",
  },
  {
    KEY: 3,
    "BEJELENTÉS SORSZÁMA": "B24030301",
    "1": "2024.04.10",
    "AKTUÁLIS NÉV": "ANDRITZ Magyarország Kft.",
    "KÉSZÜLÉK TIPUSA": "DPB-2;NCT104;SW-2.001;",
    "BEJELENTETT HIBA": "mechanikai kopás",
    "NY/Z": 1, // open
    "DOLGOZÓ": "KP;",
  },
  {
    KEY: 4,
    "BEJELENTÉS SORSZÁMA": "B24050501",
    "1": "2024.06.05",
    "AKTUÁLIS NÉV": "ANDRITZ KFT.",
    "KÉSZÜLÉK TIPUSA": "DPB-2;NCT104;",
    "BEJELENTETT HIBA": "áramellátási hiba",
    "NY/Z": 1, // open
    "DOLGOZÓ": "TP;",
  },
  {
    KEY: 5,
    "BEJELENTÉS SORSZÁMA": "B24060601",
    "1": "2024.08.12",
    "AKTUÁLIS NÉV": "ANDRITZ KFT.",
    "KÉSZÜLÉK TIPUSA": "DPB-2;NCT104;",
    "BEJELENTETT HIBA": "távoli elérés nem működik",
    "NY/Z": 1, // open
    "DOLGOZÓ": "KP;",
  },
  {
    KEY: 6,
    "BEJELENTÉS SORSZÁMA": "B24070701",
    "1": "2024.07.01",
    "AKTUÁLIS NÉV": "MÁV RT. Debrecen",
    "KÉSZÜLÉK TIPUSA": "TMV-400(10297;M10170);NCT99M;",
    "BEJELENTETT HIBA": "telepítés",
    "NY/Z": 1, // open
    "DOLGOZÓ": "TP;",
  },
];

// ---------------------------------------------------------------------------
// Test with specialized DB seeded with serviz_belso + szev_igeny rows.
// ---------------------------------------------------------------------------

let fix: Fixture;
let srv: TestServer;
let specDb: Database;

beforeAll(async () => {
  fix = buildFixture(rows);
  srv = await startTestServer(fix);

  // Seed the specialized DB with integration data.
  specDb = new Database(fix.specPath);
  specDb.exec(`
    CREATE TABLE IF NOT EXISTS serviz_belso (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      j_szam TEXT, datum_iso TEXT, datum_raw TEXT,
      cegnev TEXT, cegnev_ascii TEXT, cim TEXT, ugyfel_nev TEXT, munkaszam TEXT,
      eszkoz TEXT, eszkoz_ascii TEXT, gyariszam TEXT,
      hibajelenseg TEXT, hibajelenseg_ascii TEXT,
      elkeszules TEXT, nyitott INTEGER, munkaora REAL, dolgozo TEXT,
      vegzett_munka TEXT, vegzett_munka_ascii TEXT,
      felhasznalt_anyag TEXT, javitas_helye TEXT, megjegyzes TEXT,
      egyeb_info TEXT, source_file TEXT, source_period TEXT
    );
    CREATE TABLE IF NOT EXISTS szev_igeny (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      szev_szam TEXT, statusz INTEGER, felelos TEXT,
      igeny_datum_iso TEXT, gepallas TEXT, teljesites_datum_iso TEXT,
      attarolas_betarolas TEXT, munkaszam TEXT,
      megrendelo TEXT, megrendelo_ascii TEXT, geptipus TEXT, beszallito TEXT,
      igeny TEXT, igeny_ascii TEXT, megjegyzes TEXT,
      mennyiseg TEXT, igenylo TEXT, year INTEGER, source_file TEXT
    );
    CREATE TABLE IF NOT EXISTS telephely_munka (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sorszam TEXT, munkaszam TEXT,
      beerkezes_iso TEXT, kikuldes_iso TEXT,
      megrendelo TEXT, megrendelo_ascii TEXT,
      geptipus TEXT, geptipus_ascii TEXT,
      gepepitoelem TEXT, hibajelenseg TEXT, hibajelenseg_ascii TEXT,
      elvegzett_munka TEXT, elvegzett_munka_ascii TEXT,
      mechanikus_anyagok TEXT, elektromos_anyagok TEXT,
      dolgozo TEXT, year INTEGER, source_file TEXT
    );
  `);

  // Insert serviz_belso rows — ANDRITZ DPB-2 entries around the same time.
  specDb.prepare(`INSERT INTO serviz_belso (j_szam, datum_iso, cegnev, cegnev_ascii, eszkoz, eszkoz_ascii, hibajelenseg, vegzett_munka, dolgozo, source_period)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "J04521", "2024-03-01", "ANDRITZ KFT.", "andritz kft.", "DPB-2", "dpb-2",
    "szoftver hiba ismétlődik", " PLC újraindítás", "KP", "test",
  );
  specDb.prepare(`INSERT INTO serviz_belso (j_szam, datum_iso, cegnev, cegnev_ascii, eszkoz, eszkoz_ascii, hibajelenseg, vegzett_munka, dolgozo, source_period)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "J04522", "2024-05-15", "ANDRITZ Magyarország Kft.", "andritz magyarorszag kft.", "DPB-2", "dpb-2",
    "tápegység csere", " tápegység cserélve", "TP", "test",
  );

  // Insert szev_igeny rows.
  specDb.prepare(`INSERT INTO szev_igeny (szev_szam, megrendelo, megrendelo_ascii, geptipus, igeny, igeny_datum_iso, statusz, year, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "SZEV-2024/0891", "ANDRITZ KFT.", "andritz kft.", "DPB", "PLC csere alkatrész",
    "2024-03-10", 1, 2024, "test",
  );
  specDb.prepare(`INSERT INTO szev_igeny (szev_szam, megrendelo, megrendelo_ascii, geptipus, igeny, igeny_datum_iso, statusz, year, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "SZEV-2024/1234", "ANDRITZ KFT.", "andritz kft.", "DPB", "tápegység",
    "2024-05-01", 0, 2024, "test",
  );

  // Insert telephely_munka rows.
  specDb.prepare(`INSERT INTO telephely_munka (sorszam, megrendelo, megrendelo_ascii, geptipus, geptipus_ascii, hibajelenseg, elvegzett_munka, beerkezes_iso, year, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "TM-001", "ANDRITZ KFT.", "andritz kft.", "DPB-2", "dpb-2",
    "elektromos hiba", "vezérlő panel javítás", "2024-04-20", 2024, "test",
  );

  specDb.close();
});
afterAll(() => {
  srv.stop();
  cleanupFixture(fix);
});

// ---------------------------------------------------------------------------
// Unit tests: findRelated() function directly
// ---------------------------------------------------------------------------

describe("findRelated() function", () => {
  test("finds related CMMS tickets by customer name", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      customer: "ANDRITZ",
      window_days: 365,
    });
    // Should find the 5 ANDRITZ tickets, not the MÁV one.
    expect(result.total).toBeGreaterThanOrEqual(5);
    const cmmsEntries = result.timeline.filter((e) => e.source === "cmms");
    expect(cmmsEntries.length).toBeGreaterThanOrEqual(5);
    // None should be MÁV.
    for (const e of cmmsEntries) {
      expect(e.customer?.toLowerCase()).toContain("andritz");
    }
  });

  test("finds related CMMS tickets by device", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      device: "DPB-2",
      window_days: 365,
    });
    const cmmsEntries = result.timeline.filter((e) => e.source === "cmms");
    expect(cmmsEntries.length).toBeGreaterThanOrEqual(5);
  });

  test("excludes MÁV ticket when searching for ANDRITZ", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      customer: "ANDRITZ",
      window_days: 365,
    });
    const mavEntries = result.timeline.filter((e) =>
      e.source === "cmms" && e.customer?.includes("MÁV"),
    );
    expect(mavEntries.length).toBe(0);
  });

  test("finds serviz_belso entries", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      customer: "ANDRITZ",
      window_days: 365,
    });
    const sbEntries = result.timeline.filter((e) => e.source === "serviz_belso");
    expect(sbEntries.length).toBeGreaterThanOrEqual(2);
    // Should have J-sorszam IDs.
    expect(sbEntries[0].id).toMatch(/^J\d+$/);
  });

  test("finds szev_igeny entries", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      customer: "ANDRITZ",
      window_days: 365,
    });
    const szEntries = result.timeline.filter((e) => e.source === "szev_igeny");
    expect(szEntries.length).toBeGreaterThanOrEqual(2);
    expect(szEntries[0].id).toMatch(/^SZEV/);
  });

  test("finds telephely_munka entries", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      customer: "ANDRITZ",
      window_days: 365,
    });
    const tmEntries = result.timeline.filter((e) => e.source === "telephely_munka");
    expect(tmEntries.length).toBeGreaterThanOrEqual(1);
  });

  test("seed ticket is included when sorszam is given", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      sorszam: "B24010101",
      window_days: 365,
    });
    expect(result.seed).not.toBeNull();
    expect(result.seed!.sorszam).toBe("B24010101");
    expect(result.seed!.customer).toContain("ANDRITZ");
    expect(result.seed!.machine_type).toContain("DPB");
    // Seed itself should appear in timeline.
    const seedEntry = result.timeline.find((e) => e.id === "B24010101");
    expect(seedEntry).toBeDefined();
  });

  test("timeline is sorted chronologically", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      customer: "ANDRITZ",
      window_days: 365,
    });
    const dates = result.timeline
      .map((e) => e.date ?? "9999")
      .filter((d) => d !== "9999");
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i] >= dates[i - 1]).toBe(true);
    }
  });

  test("window_days limits results", () => {
    // Narrow window: only entries close to Jan 2024.
    const narrow = findRelated(srv.cache, srv.dbs, {
      sorszam: "B24010101",
      window_days: 30,
    });
    // Wide window: all entries.
    const wide = findRelated(srv.cache, srv.dbs, {
      sorszam: "B24010101",
      window_days: 365,
    });
    expect(narrow.total).toBeLessThanOrEqual(wide.total);
  });

  test("returns empty when no customer or device given and no sorszam", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      window_days: 180,
    });
    expect(result.total).toBe(0);
    expect(result.timeline.length).toBe(0);
  });

  test("customer name variants match bidirectionally", () => {
    // "ANDRITZ" should match all 5 ANDRITZ tickets (short name is substring of all variants).
    // "ANDRITZ KFT." matches only the 4 tickets with exact "ANDRITZ KFT." name.
    // "ANDRITZ Magyarország Kft." matches only its own ticket (too specific).
    // All should find at least 1 CMMS ticket.
    const r1 = findRelated(srv.cache, srv.dbs, { customer: "ANDRITZ", window_days: 365 });
    const r2 = findRelated(srv.cache, srv.dbs, { customer: "ANDRITZ KFT.", window_days: 365 });
    const r3 = findRelated(srv.cache, srv.dbs, { customer: "ANDRITZ Magyarország Kft.", window_days: 365 });
    expect(r1.timeline.filter((e) => e.source === "cmms").length).toBeGreaterThanOrEqual(5);
    expect(r2.timeline.filter((e) => e.source === "cmms").length).toBeGreaterThanOrEqual(4);
    expect(r3.timeline.filter((e) => e.source === "cmms").length).toBeGreaterThanOrEqual(1);
  });

  test("machine type normalization matches DPB-2 = DPB 2", () => {
    const r1 = findRelated(srv.cache, srv.dbs, { device: "DPB-2", window_days: 365 });
    const r2 = findRelated(srv.cache, srv.dbs, { device: "DPB 2", window_days: 365 });
    expect(r1.timeline.filter((e) => e.source === "cmms").length).toBe(
      r2.timeline.filter((e) => e.source === "cmms").length,
    );
  });

  test("relevance scores are in 0..1 range", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      customer: "ANDRITZ",
      window_days: 365,
    });
    for (const e of result.timeline) {
      expect(e.relevance).toBeGreaterThanOrEqual(0);
      expect(e.relevance).toBeLessThanOrEqual(1);
    }
  });

  test("sources_searched includes all available sources", () => {
    const result = findRelated(srv.cache, srv.dbs, {
      customer: "ANDRITZ",
      window_days: 365,
    });
    expect(result.sources_searched).toContain("cmms");
    // serviz_belso, szev_igeny, telephely_munka should be present
    // because we seeded them in the test fixture.
    expect(result.sources_searched).toContain("serviz_belso");
    expect(result.sources_searched).toContain("szev_igeny");
    expect(result.sources_searched).toContain("telephely_munka");
  });
});

// ---------------------------------------------------------------------------
// REST endpoint tests: POST /v1/related
// ---------------------------------------------------------------------------

describe("POST /v1/related", () => {
  test("returns timeline by customer", async () => {
    const r = await fetch(`${srv.url}/v1/related`, {
      method: "POST",
      headers: { authorization: `Bearer ${srv.readToken}`, "content-type": "application/json" },
      body: JSON.stringify({ customer: "ANDRITZ", window_days: 365 }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.total).toBeGreaterThanOrEqual(5);
    expect(j.timeline.length).toBeGreaterThanOrEqual(5);
    expect(j.summary).toContain("ANDRITZ");
    expect(j.sources_searched).toContain("cmms");
  });

  test("returns timeline by sorszam", async () => {
    const r = await fetch(`${srv.url}/v1/related`, {
      method: "POST",
      headers: { authorization: `Bearer ${srv.readToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sorszam: "B24010101", window_days: 365 }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.seed.sorszam).toBe("B24010101");
    expect(j.total).toBeGreaterThanOrEqual(1);
  });

  test("returns timeline by device", async () => {
    const r = await fetch(`${srv.url}/v1/related`, {
      method: "POST",
      headers: { authorization: `Bearer ${srv.readToken}`, "content-type": "application/json" },
      body: JSON.stringify({ device: "DPB-2", window_days: 365 }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.total).toBeGreaterThanOrEqual(5);
  });

  test("English summary when language=en", async () => {
    const r = await fetch(`${srv.url}/v1/related`, {
      method: "POST",
      headers: { authorization: `Bearer ${srv.readToken}`, "content-type": "application/json" },
      body: JSON.stringify({ customer: "ANDRITZ", window_days: 365, language: "en" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.summary).toMatch(/Related entries/);
  });

  test("empty result when no match", async () => {
    const r = await fetch(`${srv.url}/v1/related`, {
      method: "POST",
      headers: { authorization: `Bearer ${srv.readToken}`, "content-type": "application/json" },
      body: JSON.stringify({ customer: "NONEXISTENT COMPANY XYZ", window_days: 365 }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.total).toBe(0);
    expect(j.timeline.length).toBe(0);
  });

  test("requires auth", async () => {
    const r = await fetch(`${srv.url}/v1/related`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer: "ANDRITZ" }),
    });
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Router intent tests
// ---------------------------------------------------------------------------

describe("router find_related intent", () => {
  test("'folytatás' triggers find_related", () => {
    const plan = routeQuestion("mi a folytatása ennek az ügynek?");
    expect(plan.intent).toBe("find_related");
    expect(plan.primitive).toBe("find_related_tickets");
  });

  test("'előzmények' triggers find_related", () => {
    const plan = routeQuestion("ANDRITZ Kft. előzmények");
    expect(plan.intent).toBe("find_related");
    expect(plan.primitive).toBe("find_related_tickets");
    expect(plan.filters.customer).toContain("ANDRITZ");
  });

  test("'related' triggers find_related", () => {
    const plan = routeQuestion("related tickets for DPB-2");
    expect(plan.intent).toBe("find_related");
    expect(plan.primitive).toBe("find_related_tickets");
  });

  test("'continuation' triggers find_related", () => {
    const plan = routeQuestion("show me the continuation of this case");
    expect(plan.intent).toBe("find_related");
  });

  test("'history' triggers find_related", () => {
    const plan = routeQuestion("ANDRITZ DPB-2 history");
    expect(plan.intent).toBe("find_related");
  });

  test("sorszam with 'folytatás' still triggers find_related (not find_ticket)", () => {
    const plan = routeQuestion("B24010101 folytatása");
    expect(plan.intent).toBe("find_related");
    expect(plan.primitive).toBe("find_related_tickets");
    expect(plan.filters.sorszam).toBe("B24010101");
  });

  test("sorszam WITHOUT related keywords still goes to find_ticket_by_sorszam", () => {
    const plan = routeQuestion("B24010101");
    expect(plan.intent).toBe("find_ticket_by_sorszam");
    expect(plan.primitive).toBe("find_ticket_by_sorszam");
  });
});
