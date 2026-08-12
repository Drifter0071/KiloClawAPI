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
});
