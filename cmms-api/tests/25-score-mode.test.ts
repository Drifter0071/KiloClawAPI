// Tests for the scoring layer + mode switching on /v1/answer.
//
// The router picks a top-1 intent from its 48 rules. The scoring layer
// then takes that top-1, generates alternates via expandPlan(), scores
// each (top-1 keeps the base, others in the same family get -0.10), and
// returns the top-3 ranked.
//
// The mode field is "answer" if top-1 score >= 0.6, otherwise "confirm".

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
    "KÉSZÜLÉK TIPUSA": "DPB-3;M-17191;SW-3.0;",
    "BEJELENTETT HIBA": "M17191 gép hiba",
    "ELVÉGZETT MUNKA": "javítás",
    "NY/Z": 0,
  },
  {
    // Second M17191 ticket at VÁMOSGÉP so the device-scoped customer
    // drill-down has real counts (VÁMOSGÉP 2 > HAJDU 1).
    KEY: 4,
    "BEJELENTÉS SORSZÁMA": "B26081235",
    "1": "2026.08.12",
    "AKTUÁLIS NÉV": "VÁMOSGÉP KFT.",
    "KÉSZÜLÉK TIPUSA": "DPB-3;M-17191;SW-3.0;",
    "BEJELENTETT HIBA": "M17191 szervo hiba",
    "ELVÉGZETT MUNKA": "szervo csere",
    "NY/Z": 1,
  },
  {
    KEY: 5,
    "BEJELENTÉS SORSZÁMA": "B26071236",
    "1": "2026.07.12",
    "AKTUÁLIS NÉV": "HAJDU AUTOTECHNIKA KFT.",
    "KÉSZÜLÉK TIPUSA": "DPB-3;M-17191;SW-3.0;",
    "BEJELENTETT HIBA": "M17191 kijelzo hiba",
    "ELVÉGZETT MUNKA": "kijelzo csere",
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

async function ask(q: string) {
  const r = await fetch(`${server.url}/v1/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${server.readToken}` },
    body: JSON.stringify({ q }),
  });
  return { status: r.status, body: await r.json() as any };
}

describe("scoring layer", () => {
  test("returns top-3 candidates with scores for any question", async () => {
    const { body } = await ask("M26057");
    expect(body.candidates).toBeDefined();
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates.length).toBeLessThanOrEqual(3);
    for (const c of body.candidates) {
      expect(c.rank).toBeGreaterThanOrEqual(1);
      expect(c.intent).toBeTruthy();
      expect(typeof c.score).toBe("number");
      expect(c.family).toBeTruthy();
    }
  });

  test("top-1 score is highest in the list", async () => {
    const { body } = await ask("M26057");
    for (let i = 1; i < body.candidates.length; i++) {
      expect(body.candidates[i].score).toBeLessThanOrEqual(body.candidates[i - 1].score);
    }
  });

  test("score breakdown has the expected fields", async () => {
    const { body } = await ask("M26057");
    const top = body.candidates[0];
    expect(top.score_breakdown).toBeDefined();
    expect(typeof top.score_breakdown.base).toBe("number");
    expect(typeof top.score_breakdown.entity_specificity).toBe("number");
    expect(typeof top.score_breakdown.total).toBe("number");
  });

  test("mode is 'answer' or 'confirm' for any question", async () => {
    for (const q of ["M26057", "Melyik cégnél volt tavaly a legtöbb kiszállás?", "X", "B26071801"]) {
      const { body } = await ask(q);
      expect(["answer", "confirm"]).toContain(body.mode);
    }
  });

  test("confidence + threshold are echoed in the response", async () => {
    const { body } = await ask("M26057");
    expect(typeof body.confidence).toBe("number");
    expect(typeof body.threshold).toBe("number");
    expect(body.threshold).toBeGreaterThan(0);
    expect(body.threshold).toBeLessThanOrEqual(1);
  });

  test("legacy top-level fields are still present (backwards compat)", async () => {
    const { body } = await ask("M26057");
    expect(body.q).toBeTruthy();
    expect(body.intent).toBeTruthy();
    expect(body.primitive).toBeTruthy();
    expect(body.filters).toBeDefined();
    expect(body.summary).toBeTruthy();
    expect(body.follow_ups).toBeDefined();
    expect(body.results).toBeDefined();
  });

  test("bare device question answers directly (device-only plan clears 0.6)", async () => {
    // Regression: "M17191" used to score 0.20 + entity -> stuck in the
    // stale "— jó?" confirm loop. The device serial is a precise
    // identifier, so device-only plans now get base 0.50 (+0.16 entity
    // = 0.66) and answer directly.
    const { body } = await ask("M17191");
    expect(body.mode).toBe("answer");
    expect(body.candidates[0].score).toBeGreaterThanOrEqual(0.6);
  });

  test("device-scoped customer question answers per-device, not global", async () => {
    // The user's quick-select follow-up. The old router dropped the
    // device and answered the GLOBAL top customer; it must scope the
    // customer distribution to M17191 (VÁMOSGÉP 2 > HAJDU 1 in the
    // fixture) and never show the global list.
    const { body } = await ask("Melyik ügyfélnél van belőle a legtöbb az M17191 gépen?");
    expect(body.intent).toBe("device_top_customers");
    expect(body.filters.device).toBe("M17191");
    expect(body.mode).toBe("answer");
    expect(body.summary).toContain("M17191");
    expect(body.summary).toContain("géphez a legtöbb kiszállás");
    expect(body.summary).toContain("VÁMOSGÉP");
    expect(body.summary).toContain("(2)"); // VÁMOSGÉP has 2 of the 3 M17191 tickets
    expect(body.summary).not.toMatch(/^\d+ találat/);
    // The follow-up chips must carry the device so the next click keeps
    // the scope.
    expect((body.follow_ups as string[]).some((f) => f.includes("M17191"))).toBe(true);
  });
});
