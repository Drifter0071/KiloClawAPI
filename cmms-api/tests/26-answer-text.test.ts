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
  {
    // Part-spec fixture: mirrors production B25082210. The serial is in
    // the device raw (undashed, so q="M09192" matches) and the WORK note
    // carries the bearing spec ("4 db 30TAC62CSUHPN7C"). The part-spec
    // answer must extract it instead of returning a hit counter.
    KEY: 8,
    "BEJELENTÉS SORSZÁMA": "B25082210",
    "1": "2025.08.22",
    "AKTUÁLIS NÉV": "HAJDU AUTOTECHNIKA IPARI ZRT.",
    "KÉSZÜLÉK TIPUSA": "EmL-610 (08277;M15250;M09192) NCT204",
    "BEJELENTETT HIBA": "X tengely csapágyazására is készüljünk, ha szükséges",
    "ELVÉGZETT MUNKA": "burkolatok le- visszaszerelése, X tengely golyósorsó csapágyak cseréje 4 db 30TAC62CSUHPN7C, próba",
    "NY/Z": 0,
  },
  {
    // Part-spec trap: mirrors production B26061802 — NEWER than row 8,
    // same machine serial (M09192 in the device raw), same part stems,
    // but about the Y-AXIS and only a bare type code ("30TAC42 NSK", no
    // quantity). The X-axis complete card (row 8) must win over this
    // newer Y-axis partial one.
    KEY: 9,
    "BEJELENTÉS SORSZÁMA": "B26061802",
    "1": "2026.06.18",
    "AKTUÁLIS NÉV": "HAJDU AUTOTECHNIKA IPARI ZRT.",
    "KÉSZÜLÉK TIPUSA": "EmL-610 (08277;M15250;M09192/P25551) NCT204",
    "BEJELENTETT HIBA": "Kérem küldjön ajánlatot a 610-es gépünkön az Y-tengely csapágyazásának a cseréjére. Emellett a z-tengelyen is van hiba. Koppanás hallható használat közben. Valószínűleg tengelykapcsoló hiba.",
    "ELVÉGZETT MUNKA": "Y burkolatok kiszerelése, Y golyósorsó kiszerelés, ügyfél végzi a javítást, csapágyak cseréje 30TAC42 NSK - ügyfél biztosította, Z és Y kuplung csillag összetört, cserélni kell",
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

  test("symptom statement without request phrase routes to problem_solution", async () => {
    // The user states the fault ("Elsötétült az NCT 204 kijelzője")
    // without "hogyan tudom megjavítani" — this used to fall through
    // to a plain hit counter ("7044 találat minden idők..."). It must
    // answer with historical fixes instead.
    const { body } = await ask("Elsötétült az NCT 204 kijelzője");
    expect(body.intent).toBe("problem_solution");
    expect(body.summary).not.toMatch(/^\d+ találat/);
    expect(body.summary).toContain("javítás található");
    expect(body.summary).toContain("kijelző csere megtörtént");
    expect(body.summary).not.toContain("tápegység csere");
  });

  test("user's typo (elsötéltült) in a statement still routes to problem_solution", async () => {
    // "elsötéltült" shares a 5-char prefix with "elsötétült" (elsot),
    // so the prefix-tolerant symptom match catches the habitual typo.
    const { body } = await ask("Elsötéltült az NCT 204 kijelzője");
    expect(body.intent).toBe("problem_solution");
    expect(body.summary).not.toMatch(/^\d+ találat/);
    expect(body.summary).toContain("javítás található");
  });

  test("symptom statement with different word order routes to problem_solution", async () => {
    const { body } = await ask("Az NCT 204 kijelzője elsötétült");
    expect(body.intent).toBe("problem_solution");
    expect(body.summary).toContain("javítás található");
    expect(body.summary).toContain("háttérvilágítás");
  });

  test("'nem indul' statement routes to problem_solution", async () => {
    const { body } = await ask("Az M26057 gép nem indul");
    expect(body.intent).toBe("problem_solution");
    expect(body.filters.device).toBe("M26057");
    // No historical match for this symptom on M26057 in the fixture ->
    // honest not-found, never a hit counter.
    expect(body.summary).not.toMatch(/^\d+ találat/);
    expect(body.summary).toContain("M26057");
  });

  test("list request with 'hibáit' stays a device list, not problem_solution", async () => {
    // Bare "hibáit" is not a fault statement — it asks for a list.
    const { body } = await ask("Mutasd az M26057 gép hibáit");
    expect(body.intent).toBe("device_tickets_list");
  });

  test("question-word forms stay on their own intents", async () => {
    const top = await ask("Mi a leggyakoribb hibája az M26057 gépen?");
    expect(top.body.intent).toBe("device_top_problem");
    const count = await ask("Hány ticket volt az M26057 gépen?");
    expect(count.body.intent).toBe("device_total_count");
  });

  test("English statement without request phrase routes to problem_solution", async () => {
    const { body } = await ask("The NCT 204 display is dark", "en");
    expect(body.intent).toBe("problem_solution");
    expect(body.summary).toContain("similar");
    expect(body.summary).not.toMatch(/^\d+ matches/);
  });

  test("part-spec question answers with the extracted type and quantity", async () => {
    // The exact question the user reported: the old answer was
    // "50 találat minden idők. Az első sorszám: B26061810." — the spec
    // lives in B25082210's work note ("4 db 30TAC62CSUHPN7C").
    const { body } = await ask(
      "X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál",
    );
    expect(body.intent).toBe("part_spec");
    expect(body.filters.device).toBe("M09192");
    expect(body.summary).toContain("30TAC62CSUHPN7C");
    expect(body.summary).toContain("4 db");
    expect(body.summary).toContain("B25082210");
    expect(body.summary).not.toMatch(/^\d+ találat/);
  });

  test("part-spec prefers the complete same-axis card over a newer different-axis one", async () => {
    // Row 9 (B26061802, 2026-06-18) is newer than row 8 (B25082210,
    // 2025-08-22) and matches the same part stems, but it is a Y-axis
    // ticket with only a bare type code. The X-axis "4 db
    // 30TAC62CSUHPN7C" card must still be cited.
    const { body } = await ask(
      "X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál",
    );
    expect(body.intent).toBe("part_spec");
    expect(body.summary).toContain("30TAC62CSUHPN7C");
    expect(body.summary).toContain("4 db");
    expect(body.summary).toContain("B25082210");
    expect(body.summary).not.toContain("30TAC42");
    expect(body.summary).not.toContain("B26061802");
  });

  test("part-spec question with no spec in the data answers honestly", async () => {
    const { body } = await ask("Milyen csapágy kell az M99999 gépen?");
    expect(body.intent).toBe("part_spec");
    expect(body.filters.device).toBe("M99999");
    expect(body.summary).toContain("nem található");
    expect(body.summary).not.toMatch(/^\d+ találat/);
  });

  test("part-spec does not steal frequency / requisition / spare-motor questions", async () => {
    const stats = await ask("Melyik csapágy hibásodik meg a leggyakrabban?");
    expect(stats.body.intent).not.toBe("part_spec");
    const order = await ask("Milyen alkatrészeket rendeltünk az ANDRITZ Kft.-hez?");
    expect(order.body.intent).not.toBe("part_spec");
    const spare = await ask("Melyik NCT motor zárlatos most a raktárban?");
    expect(spare.body.intent).not.toBe("part_spec");
  });

  test("attribute questions stay on the attribute path, not part_spec", async () => {
    const { body } = await ask("Milyen vezérlés található az M26057 gépen?");
    expect(body.intent).not.toBe("part_spec");
    expect(body.summary).toContain("vezérlése");
  });
});

describe("grammar engine in the answer templates", () => {
  test("bare attr noun question answers directly (M26057 vezérlés)", async () => {
    // The user's exact report: "M26057 vezérlés" (no question word, no
    // "milyen"). The router drops the single leftover token from q, so
    // detectAttr must fall back to the FULL question — otherwise this
    // degrades to a hit counter.
    const { body } = await ask("M26057 vezérlés");
    expect(body.intent).toBe("device_tickets_list");
    expect(body.filters.device).toBe("M26057");
    expect(body.summary).toContain("vezérlése");
    expect(body.summary).toContain("Az M26057");
    expect(body.summary).not.toMatch(/^\d+ találat/);
  });

  test("controller answer uses 'Az' + lowercase '(forrás:'", async () => {
    const { body } = await ask("Milyen vezérlés található az M26057 gépen?");
    // Grammar engine: M = "em" -> "Az M26057 vezérlése"; citation is
    // lowercase "(forrás:" — never "A(z)" or "(Forrás:".
    expect(body.summary).toContain("Az M26057 vezérlése");
    expect(body.summary).not.toContain("A(z)");
    expect(body.summary).toContain("(forrás:");
    expect(body.summary).not.toContain("(Forrás:");
  });

  test("part-spec citation reads 'a B25082210 számú jegy szerint (…)'", async () => {
    const { body } = await ask(
      "X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál",
    );
    expect(body.intent).toBe("part_spec");
    // B = "bé" -> "a B25082210 számú jegy szerint", with the who/when
    // moved into the trailing parenthetical (not "— a B25082210 (…)
    // jegy szerint").
    expect(body.summary).toContain("a B25082210 számú jegy szerint (HAJDU AUTOTECHNIKA IPARI ZRT., 2025-08-22)");
    expect(body.summary).not.toContain("A(z)");
  });

  test("device_top_problem answer uses 'Az <device>'", async () => {
    const { body } = await ask("Mi a leggyakoribb hibája az M26057 gépen?");
    expect(body.intent).toBe("device_top_problem");
    expect(body.summary).toContain("Az M26057 leggyakoribb hibái");
  });

  test("related-entries summary uses 'Az <sorszam>'", async () => {
    const { body } = await ask("Mutasd az M26057 gép teljes történetét");
    // find_related (device seed) — the summary must read "Az M26057",
    // not "A(z) M26057".
    if (body.summary && !body.summary.startsWith("Kapcsolódó")) {
      expect(body.summary).not.toContain("A(z)");
    }
  });
});
