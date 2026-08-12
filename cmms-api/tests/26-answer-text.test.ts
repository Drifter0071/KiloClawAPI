// Tests for the answer-text layer: /v1/answer must actually answer
// attribute questions ("Milyen vezérlés található az M26057 gépen?")
// instead of returning a hit counter ("1 találat: B26071801").
//
// The attribute extractor lives in src/lib/answer_text.ts and reads
// JobCard.devices[] + note bodies. These tests exercise the whole
// /v1/answer path with the fixture so the router → execute → summary
// chain is covered end-to-end.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";

let server: TestServer;
let fx: Fixture;

const rows: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B26071801",
    "1": "2026.07.18",
    "AKTUÁLIS NÉV": "PLASMA-TECH SYSTEMS KFT.",
    "KÉSZÜLÉK TIPUSA": "NCT99;M-26057;SW-2.0;",
    "BEJELENTETT HIBA": "Vezérlő: NCT iHDW-A2 firmware v3.41",
    "ELVÉGZETT MUNKA": "tápegység csere",
    "NY/Z": 1,
  },
  {
    KEY: 2,
    "BEJELENTÉS SORSZÁMA": "B26061810",
    "1": "2026.06.18",
    "AKTUÁLIS NÉV": "HAJDU AUTOTECHNIKA KFT.",
    "KÉSZÜLÉK TIPUSA": "EmL-610;M-09192;SW-1.0;",
    "BEJELENTETT HIBA": "X tengely golyós orsó csapágyak",
    "ELVÉGZETT MUNKA": "csapágy csere",
    "NY/Z": 0,
  },
  {
    KEY: 3,
    "BEJELENTÉS SORSZÁMA": "B25072420",
    "1": "2025.07.24",
    "AKTUÁLIS NÉV": "VÁMOSGÉP KFT.",
    "KÉSZÜLÉK TIPUSA": "TMV-400;M-99999;SW-3.1;",
    "BEJELENTETT HIBA": "M99999 gép hiba",
    "ELVÉGZETT MUNKA": "javítás",
    "NY/Z": 0,
  },
];

beforeAll(async () => {
  fx = buildFixture(rows);
  server = await startTestServer(fx);
});

afterAll(() => {
  server.stop();
  cleanupFixture(fx);
});

async function ask(q: string, language?: "hu" | "en") {
  const r = await fetch(`${server.url}/v1/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${server.readToken}` },
    body: JSON.stringify({ q, ...(language ? { language } : {}) }),
  });
  return { status: r.status, body: await r.json() as any };
}

describe("answer text", () => {
  test("controller question answers directly (device, search path)", async () => {
    const { body } = await ask("Milyen vezérlés található az M26057 gépen?");
    expect(body.summary).toContain("vezérlése");
    expect(body.summary).toContain("NCT iHDW-A2");
    expect(body.summary).not.toContain("1 találat");
  });

  test("controller question via the stats route (vezérlő, not vezérlés)", async () => {
    const { body } = await ask("Milyen vezérlő van az M26057 gépen?");
    expect(body.summary).toContain("vezérlése");
    // The devices[] parse gives NCT99 (the note-based "NCT iHDW-A2"
    // only appears on ticket B26071801's reported note).
    expect(body.summary).toContain("NCT");
    expect(body.summary).not.toContain("1 találat");
  });

  test("software question answers from the SW- field", async () => {
    const { body } = await ask("Milyen szoftver van az M26057-en?");
    expect(body.summary).toContain("szoftvere");
    expect(body.summary).toContain("2.0");
  });

  test("machine-type question via the stats route", async () => {
    const { body } = await ask("Milyen géptípus az M26057?");
    // Routed to top_machine_type; the M26057 device row itself is not
    // a machine type, so we accept either a direct answer or a clean
    // "no machine type recorded" line — but never a bare counter.
    expect(body.summary).not.toMatch(/^0 találat/);
    expect(body.summary.length).toBeGreaterThan(10);
  });

  test("sorszam attribute question keeps the attribute from the prose", async () => {
    const { body } = await ask("Milyen vezérlés van a B26071801 munkán?");
    expect(body.summary).toContain("B26071801");
    expect(body.summary).toContain("vezérlése");
  });

  test("English question answers in English", async () => {
    const { body } = await ask("What controller is on the M26057 machine?", "en");
    expect(body.summary).toContain("controller");
    expect(body.summary).toContain("NCT");
    expect(body.summary).not.toContain("1 találat");
  });

  test("plain device list stays a list summary (no attribute word)", async () => {
    const { body } = await ask("M26057");
    // Bare device question has no attribute — keep the counter shape
    // so list semantics don't silently turn into a single attribute.
    expect(body.summary).toContain("találat");
  });

  test("no-fault device keeps the not-found message shape", async () => {
    const { body } = await ask("Milyen vezérlés van a M99999 gépen?");
    expect(body.summary).toContain("M99999");
  });
});
