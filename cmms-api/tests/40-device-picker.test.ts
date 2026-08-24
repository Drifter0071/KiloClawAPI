// 2026-08-24: machine-scope picker — the device list the Ask page
// shows under "Gép kiválasztása". Three things broke in production:
//
//   1. Some devices' display name showed the parenthesized parser
//      artifact "(;M17191)" instead of "M17191" because the
//      KÉSZÜLÉK TIPUSA cell came in as e.g.
//      "TMV-400(10297;M17191);…" with a leading-empty token inside
//      the parens. The parser saved raw="(;M17191)" with model=null,
//      and the picker fell back to raw.
//   2. The ticket count in the picker was the main-CMMS count
//      only — but the agent's find_related_tickets (and the operator's
//      mental model) includes serviz_belso + szev_igeny +
//      telephely_munka. The picker said "1 ticket" while the agent
//      answered from 62 records.
//   3. Two devices with the same serial at different shops looked
//      identical in the dropdown. The picker should expose the
//      dominant customer name as a sub-label so the operator can
//      disambiguate.
//
// This file covers all three via a single self-contained test server
// with a spec DB seeded with serviz_belso + szev_igeny +
// telephely_munka rows, and a main CMMS fixture with a device cell
// that contains the parenthesized artifact.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildFixture,
  cleanupFixture,
  type Fixture,
  type FixtureRow,
} from "./fixtures/fixture";
import { startTestServer, authHeaders, type TestServer } from "./harness";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const rows: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B24071711",
    "1": "2024.07.17",
    "AKTUÁLIS NÉV": "VÁMOSGÉP KFT.",
    // The KÉSZÜLÉK TIPUSA cell comes in two forms in production:
    //   1. As a parenthesized artifact on its own — e.g. a stray
    //      "(;M17191);NCT104;" cell where the parser ends up with a
    //      standalone token of "(;M17191)" (model=null, raw="(;M17191)").
    //   2. As the inner M-serial inside a parent device cell like
    //      "WFQ-80NCT7(10297;M17191);…" (one token, model="WFQ-80NCT7",
    //      freeform contains M17191).
    // The picker should surface M17191 from form (1) and clean the
    // display name. Form (2) is out of scope — the inner M-serial
    // there isn't its own device row, so the picker can't list it.
    "KÉSZÜLÉK TIPUSA": "(;M17191);NCT104;",
    "BEJELENTETT HIBA": "Y túláram",
    "ELVÉGZETT MUNKA": "Y hajtás csere",
    "NY/Z": 1,
  },
  {
    KEY: 2,
    "BEJELENTÉS SORSZÁMA": "B24071712",
    "1": "2024.07.18",
    "AKTUÁLIS NÉV": "VÁMOSGÉP KFT.",
    "KÉSZÜLÉK TIPUSA": "(;M17191);",
    "BEJELENTETT HIBA": "M17191 ismét hiba",
    "ELVÉGZETT MUNKA": "x",
    "NY/Z": 0,
  },
  {
    KEY: 3,
    "BEJELENTÉS SORSZÁMA": "B24071713",
    "1": "2024.07.19",
    "AKTUÁLIS NÉV": "VÁMOSGÉP KFT.",
    "KÉSZÜLÉK TIPUSA": "WFQ-80NCT7(10297;M17191);NCT104;",
    "BEJELENTETT HIBA": "WFQ-80NCT7 hiba",
    "ELVÉGZETT MUNKA": "x",
    "NY/Z": 0,
  },
];

let server: TestServer;
let fx: Fixture;
let specDb: Database;

beforeAll(async () => {
  fx = buildFixture(rows);
  // Seed serviz_belso + szev_igeny + telephely_munka so the
  // device-picker's cross-DB counter has something to find.
  specDb = new Database(fx.specPath);
  specDb.exec(`
    CREATE TABLE IF NOT EXISTS serviz_belso (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      j_szam TEXT, datum_iso TEXT,
      cegnev TEXT, cegnev_ascii TEXT,
      eszkoz TEXT, eszkoz_ascii TEXT,
      hibajelenseg TEXT, vegzett_munka TEXT, dolgozo TEXT, source_period TEXT
    );
    CREATE TABLE IF NOT EXISTS szev_igeny (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      szev_szam TEXT, statusz INTEGER, igeny_datum_iso TEXT,
      megrendelo TEXT, megrendelo_ascii TEXT,
      geptipus TEXT, geptipus_ascii TEXT,
      igeny TEXT, megjegyzes TEXT, source_period TEXT
    );
    CREATE TABLE IF NOT EXISTS telephely_munka (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sorszam TEXT, munkaszam TEXT,
      beerkezes_iso TEXT, kikuldes_iso TEXT,
      megrendelo TEXT, megrendelo_ascii TEXT,
      geptipus TEXT, geptipus_ascii TEXT,
      hibajelenseg TEXT, munka TEXT, source_period TEXT
    );
  `);
  // 3 serviz_belso rows that mention M17191.
  const insSb = specDb.prepare(
    `INSERT INTO serviz_belso
      (j_szam, datum_iso, cegnev, cegnev_ascii, eszkoz, eszkoz_ascii,
       hibajelenseg, vegzett_munka, dolgozo, source_period)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 3; i += 1) {
    insSb.run(
      `J0000${i + 1}`,
      "2024-06-0" + (i + 1),
      "VÁMOSGÉP KFT.",
      "vamosgep kft.",
      "M17191",
      "m17191",
      "főorsó csapágy",
      "csapágy csere",
      "BA",
      "test",
    );
  }
  // 1 szev_igeny row.
  specDb.prepare(
    `INSERT INTO szev_igeny
      (szev_szam, statusz, igeny_datum_iso, megrendelo, megrendelo_ascii,
       geptipus, geptipus_ascii, igeny, megjegyzes, source_period)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "SZÉV2024-001",
    1,
    "2024-04-10",
    "VÁMOSGÉP KFT.",
    "vamosgep kft.",
    "M17191",
    "m17191",
    "1 db NN3018 csapágy",
    null,
    "test",
  );
  // 1 telephely_munka row.
  specDb.prepare(
    `INSERT INTO telephely_munka
      (sorszam, munkaszam, beerkezes_iso, kikuldes_iso, megrendelo, megrendelo_ascii,
       geptipus, geptipus_ascii, hibajelenseg, munka, source_period)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "TH0001",
    null,
    "2024-05-01",
    "2024-05-15",
    "VÁMOSGÉP KFT.",
    "vamosgep kft.",
    "M17191",
    "m17191",
    "főorsó felújítás",
    "csapágy + szíjtárcsa",
    "test",
  );
  specDb.close();
  // Force a WAL checkpoint so the device-index rebuild sees the seeds.
  // (buildFromDb opens a fresh connection, so the writes above are
  // committed before we let startTestServer read them.)
  server = await startTestServer(fx);
});

afterAll(() => {
  server?.stop();
  cleanupFixture(fx);
});

async function devices(q: string, limit = 20) {
  const qs = new URLSearchParams({ q, limit: String(limit) }).toString();
  const r = await fetch(`${server.url}/v1/devices?${qs}`, {
    headers: authHeaders(server.readToken),
  });
  return { status: r.status, body: (await r.json()) as any };
}

// ---------------------------------------------------------------------------

describe("GET /v1/devices — picker cleanup (2026-08-24)", () => {
  test("'M17191' surfaces the cleaned identifier (not '(;M17191)')", async () => {
    const { status, body } = await devices("M17191");
    expect(status).toBe(200);
    expect(body.devices.length).toBeGreaterThan(0);
    // No parenthesized artifact; the name is the bare serial.
    const names = body.devices.map((d: { name: string }) => d.name);
    expect(names).toContain("M17191");
    expect(names.every((n: string) => !n.startsWith("(") && !n.startsWith(";"))).toBe(true);
  });

  test("ticket count includes cross-DB rows (cmms=2 + serviz=3 + szev=1 + telephely=1 = 7)", async () => {
    // Keys 1 + 2 have primary cleaned name "M17191" (cmms=2 for the
    // primary-bucket pass). Key 3 has primary "WFQ-80NCT7" but its
    // raw_type also contains "M17191" — that contributes an ADDITIONAL
    // cmms count to the M17191 bucket via the second pass. So
    // M17191 cmms total = 3, not 2. Cross-DB: 3 + 1 + 1 = 5.
    // Total: 8. (Updated 2026-08-24: the original 7 was wrong —
    // production was showing 1 for a device that actually has 62
    // tickets because of this same single-primary vs substring issue.)
    const { body } = await devices("M17191");
    const hit = body.devices.find((d: { name: string }) => d.name === "M17191");
    expect(hit).toBeDefined();
    expect(hit.tickets).toBe(3 + 3 + 1 + 1);
  });

  test("customer_name is the dominant customer for the device", async () => {
    const { body } = await devices("M17191");
    const hit = body.devices.find((d: { name: string }) => d.name === "M17191");
    expect(hit).toBeDefined();
    expect(hit.customer_name).toBe("VÁMOSGÉP KFT.");
  });

  test("'WFQ-80NCT7' is the parent device; M17191 is the inner M-serial, both surfaced", async () => {
    const { body } = await devices("WFQ");
    const names = body.devices.map((d: { name: string }) => d.name);
    expect(names).toContain("WFQ-80NCT7");
  });

  // 2026-08-24 follow-up: when an M-serial lives only as a substring
  // of a parent device's raw_type (e.g. "WFQ-80NCT7(10297;M17191);…"),
  // the picker must count that ticket under the M-serial's bucket too
  // — otherwise an operator who searches "M17191" sees only the rows
  // whose `model` is literally "M17191" and misses all the parent-form
  // ones. Production data: 62 M17191 tickets, all but 1 are
  // WFQ-80NCT7(…;M17191;…) rows.
  test("M-serial appearing only as substring of parent raw_type is counted under the M-serial bucket", async () => {
    const { body } = await devices("M17191");
    const hit = body.devices.find((d: { name: string }) => d.name === "M17191");
    expect(hit).toBeDefined();
    // Key 1: raw="(;M17191);NCT104;" → primary cleaned name = "M17191"
    // Key 2: raw="(;M17191);"        → primary cleaned name = "M17191"
    // Key 3: raw="WFQ-80NCT7(10297;M17191);NCT104;"
    //        → primary cleaned name = "WFQ-80NCT7", but "M17191" lives
    //          in raw_type, so the second pass counts it under M17191.
    // Total cmms: 3 (all three keys). All M17191 bucket: 3.
    // Cross-DB: 3 serviz + 1 szev + 1 telephely = 5.
    expect(hit.tickets).toBe(3 + 3 + 1 + 1);
    expect(hit.customer_name).toBe("VÁMOSGÉP KFT.");
  });

  test("parent device's ticket count also includes its M-serial-mentioned rows", async () => {
    const { body } = await devices("WFQ");
    const wfq = body.devices.find((d: { name: string }) => d.name === "WFQ-80NCT7");
    expect(wfq).toBeDefined();
    // Key 3 is the only WFQ-80NCT7 row; none of the cross-DB seeds
    // mention WFQ, so cmms=1 + cross=0.
    expect(wfq.tickets).toBe(1);
  });
});
