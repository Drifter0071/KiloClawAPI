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
  {
    // Mirrors real production data: the device cell is a raw row like
    // "NCTNCT 4(17 20x xxx)" where the model number ("4") parses into
    // freeform, not model/controller. The answer must give the model
    // number back: "NCTNCT 4" (see appendModelNumber).
    KEY: 4,
    "BEJELENTÉS SORSZÁMA": "B26081234",
    "1": "2026.08.12",
    "AKTUÁLIS NÉV": "METARAD KFT.",
    "KÉSZÜLÉK TIPUSA": "NCTNCT 4(17 20x xxx);M-55555;",
    "BEJELENTETT HIBA": "nem indul",
    "ELVÉGZETT MUNKA": "javítás",
    "NY/Z": 0,
  },
  {
    // Problem -> solution fixture: an NCT-204 with a dark-display fault
    // that was fixed by replacing the display. Matches "elsötétült" +
    // "kijelző" (2 problem tokens).
    KEY: 5,
    "BEJELENTÉS SORSZÁMA": "B26080201",
    "1": "2026.08.02",
    "AKTUÁLIS NÉV": "PLASMA-TECH SYSTEMS KFT.",
    "KÉSZÜLÉK TIPUSA": "NCT-204;M-77777;SW-4.1;",
    "BEJELENTETT HIBA": "elsötétült a kijelző",
    "ELVÉGZETT MUNKA": "kijelző csere megtörtént",
    "NY/Z": 0,
  },
  {
    // Same machine family, same symptom family ("kijelző nem világít"
    // only matches "kijelző" — the OR-match must still surface it).
    KEY: 6,
    "BEJELENTÉS SORSZÁMA": "B26050202",
    "1": "2026.05.02",
    "AKTUÁLIS NÉV": "HAJDU AUTOTECHNIKA KFT.",
    "KÉSZÜLÉK TIPUSA": "NCT-204;M-88888;SW-4.1;",
    "BEJELENTETT HIBA": "kijelző nem világít",
    "ELVÉGZETT MUNKA": "inverter csere + kijelző háttérvilágítás",
    "NY/Z": 0,
  },
  {
    // NCT-204 ticket with a DIFFERENT problem (power supply) — must NOT
    // match a dark-display question.
    KEY: 7,
    "BEJELENTÉS SORSZÁMA": "B26010202",
    "1": "2026.01.02",
    "AKTUÁLIS NÉV": "VÁMOSGÉP KFT.",
    "KÉSZÜLÉK TIPUSA": "NCT-204;M-99998;SW-4.1;",
    "BEJELENTETT HIBA": "tápegység hiba",
    "ELVÉGZETT MUNKA": "tápegység csere",
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

  test("controller answer keeps the model number (NCTNCT 4)", async () => {
    // Raw device row "NCTNCT 4(17 20x xxx)" — the "4" parses into
    // freeform, so the answer must append it back to the controller.
    const { body } = await ask("Milyen vezérlés található az M55555 gépen?");
    expect(body.summary).toContain("vezérlése");
    expect(body.summary).toContain("NCTNCT 4");
    expect(body.summary).not.toContain("1 találat");
  });

  test("model attribute answer keeps the model number too", async () => {
    const { body } = await ask("Milyen modell van az M55555 gépen?");
    expect(body.summary).toContain("NCTNCT 4");
  });

  test("follow-up chips carry the device scope (az M26057 gépen)", async () => {
    const { body } = await ask("Milyen vezérlés található az M26057 gépen?");
    const chips = body.follow_ups as string[];
    expect(Array.isArray(chips)).toBe(true);
    expect(chips.length).toBeGreaterThan(0);
    // The static "Mi a leggyakoribb hibája?" must be scoped to the
    // machine the answer was about, or clicking it loses the entity.
    expect(chips[0]).toBe("Mi a leggyakoribb hibája az M26057 gépen?");
  });

  test("clicking the contextualized follow-up keeps the device scope", async () => {
    const { body } = await ask("Mi a leggyakoribb hibája az M26057 gépen?");
    // Must route to the device-scoped stats intent, not top_hubs or a
    // bare search — the top_hubs "Minden idők B24090503" answer the
    // user saw live means the device was lost.
    expect(body.intent).toBe("device_top_problem");
    expect(body.summary).toContain("M26057");
    expect(body.summary).toContain("leggyakoribb hibái");
  });

  test("typo variant (leggyakorubi) still routes to device_top_problem", async () => {
    const { body } = await ask("Mi a leggyakorubi hibája az M26057 gépen?");
    expect(body.intent).toBe("device_top_problem");
    expect(body.summary).toContain("M26057");
  });

  test("problem-solution question answers with historical fixes", async () => {
    const { body } = await ask("Elsötétült az NCT 204 kijelzője, hogyan tudom megjavítani?");
    expect(body.intent).toBe("problem_solution");
    // The answer must synthesize what was done before, not count hits.
    expect(body.summary).not.toMatch(/^\d+ találat/);
    expect(body.summary).toContain("javítás található");
    // Both display faults match (OR on problem tokens): the exact
    // "elsötétült a kijelző" fix and the paraphrase "kijelző nem
    // világít". The power-supply ticket must NOT appear.
    expect(body.summary).toContain("kijelző csere megtörtént");
    expect(body.summary).toContain("háttérvilágítás");
    expect(body.summary).not.toContain("tápegység csere");
  });

  test("problem-solution question keeps the device scope", async () => {
    const { body } = await ask("Hogyan javítsam meg a TMV-400 szivattyúját?");
    expect(body.intent).toBe("problem_solution");
    expect(body.filters.device).toBe("TMV-400");
    // No historical match for this symptom on TMV-400 -> honest
    // not-found, not a hit counter.
    expect(body.summary).toContain("Nem található korábbi hasonló javítás");
    expect(body.summary).toContain("TMV-400");
  });

  test("English problem-solution question answers in English", async () => {
    const { body } = await ask("The display on NCT 204 went dark, how do I fix it?", "en");
    expect(body.intent).toBe("problem_solution");
    expect(body.summary).toContain("similar");
    expect(body.summary).toContain("fix");
    expect(body.summary).not.toMatch(/^\d+ matches/);
  });
});
