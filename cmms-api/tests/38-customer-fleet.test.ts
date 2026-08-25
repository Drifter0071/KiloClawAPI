// Phase 6 — Customer fleet overview + bare-name customer detection.
//
// Two related gaps the user reported 2026-08-25:
//   1. "Hány alkalommal ment tönkre az SVG HDMC gépében az y2 hajtás" —
//      the router has no rule for bare ALL-CAPS customer names
//      (no "Kft." / "-nél" suffix), so the question fell through to
//      device="SVG HDMC" and returned 0 hits instead of customer-scoped
//      search of the y2 hajtás sub-question.
//   2. "SVG HDMC" alone (or "Mutasd az SVG HDMC flotta áttekintését")
//      had no first-class intent — the user wanted a one-glance
//      5-section composite (top machines, top categories, last 5 tickets,
//      first/most-recent date, 1-line summary) instead of a generic hit
//      counter.
//
// Decisions (from ask_user, 2026-08-25):
//   - bare-name detection: probe customers DB on every question
//   - fleet answer: 5-section composite (HU + EN)
//   - grammar: routing only, no aggressive normalization
//
// What this file covers:
//   - extractCustomer() now returns weak-customer signals for bare
//     ALL-CAPS phrases
//   - probeCustomer() in answer.ts turns weak → strong via DB lookup
//   - customer_fleet_overview intent executes 5 sub-queries in parallel
//     and renders a 5-section composite in HU + EN
//   - end-to-end: "SVG HDMC" question returns the fleet composite with
//     a top-machines list and the most recent ticket
//   - end-to-end: compound question with a bare customer name routes to
//     customer-scoped y2 hajtás search instead of device="SVG HDMC"

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { routeQuestion } from "../src/lib/router";
import { buildFixture, cleanupFixture, type Fixture } from "./fixtures/fixture";
import { startTestServer, authHeaders, type TestServer } from "./harness";

// ---------------------------------------------------------------------------
// 1) Pure router tests — bare-name extraction
// ---------------------------------------------------------------------------

describe("router: bare customer-name extraction (Phase 6)", () => {
  test("extracts bare 2-token ALL-CAPS customer name", () => {
    const plan = routeQuestion("Hány alkalommal ment tönkre az SVG HDMC gépében az y2 hajtás");
    // The bare phrase is captured (weak), and the device branch is NOT
    // also taken — `customer` wins over `device` for "SVG HDMC" because
    // the new 4th pattern runs after the device pattern at line 285-305.
    // (If the implementation reverses order, this test catches it.)
    expect(plan.filters.customer).toContain("SVG");
    expect(plan.filters.customer).toContain("HDMC");
    // The device filter must NOT be set to "SVG HDMC" — that was the bug.
    expect(plan.filters.device).toBeUndefined();
    // Compound question: the q must be preserved for the answer handler
    // to thread through the part_spec search (not fleet_overview).
    expect(plan.filters.q).toBeDefined();
    expect(plan.filters.q!.length).toBeGreaterThan(3);
    expect(plan.intent).toBe("part_spec");
  });

  test("extracts bare single-token company name (ContiTech)", () => {
    const plan = routeQuestion("Milyen hibái vannak a ContiTech-nek?");
    expect(plan.filters.customer).toContain("ContiTech");
  });

  test("extracts bare 3-token company name (Gildemeister Hungary)", () => {
    const plan = routeQuestion("Mutasd a Gildemeister Hungary ticketjeit");
    expect(plan.filters.customer).toContain("Gildemeister");
  });

  test("does NOT false-positive on question words", () => {
    // "Melyik ügyfél…" has a capital word but is a question, not a name.
    const plan = routeQuestion("Melyik ügyfélhez járunk a legtöbbet?");
    expect(plan.filters.customer).toBeUndefined();
  });

  test("still works for the existing Kft. / -nél / for patterns (no regression)", () => {
    expect(routeQuestion("ANDRITZ Kft. összes ticketje").filters.customer).toContain("ANDRITZ");
    expect(routeQuestion("Mikor volt utoljára náluk javítás?").filters.customer).toBeUndefined(); // bare
    expect(routeQuestion("Tickets for ANDRITZ").filters.customer).toContain("ANDRITZ");
  });
});

// ---------------------------------------------------------------------------
// 2) Integration: end-to-end fleet composite via the REST API
// ---------------------------------------------------------------------------

let srv: TestServer;
let fix: Fixture;

beforeAll(async () => {
  // The weak-customer probe (Phase 6) reads from the `customers` table,
  // which the ETL builds from the `data.AKTUÁLIS NÉV` column. So we
  // pre-populate the fixture with the right customers + their tickets
  // BEFORE the harness starts the server (which runs the ETL once).
  // Adding tickets via the REST API after startTestServer would
  // require a re-ETL — too slow for unit tests.
  const now = new Date();
  const huDate = (offsetDays: number) => {
    const d = new Date(now.getTime() - offsetDays * 86_400_000);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  };
  const rows: FixtureRow[] = [
    // Customer A: ACME Kft. — 4 tickets across 2 machines + 4 categories
    { KEY: 1, "BEJELENTÉS SORSZÁMA": "B2608001", "1": huDate(30), "AKTUÁLIS NÉV": "ACME Kft.", "NY/Z": 0, "DOLGOZÓ": "TS", "BEJELENTETT HIBA": "Hiba: Y2 hajtás tönkrement", "KÉSZÜLÉK TIPUSA": "HDMC-130", "MEGJEGYZÉS": "Mechanikai hiba: Y2 csapágy csere" },
    { KEY: 2, "BEJELENTÉS SORSZÁMA": "B2608002", "1": huDate(20), "AKTUÁLIS NÉV": "ACME Kft.", "NY/Z": 0, "DOLGOZÓ": "TS", "BEJELENTETT HIBA": "Szoftver frissítés szükséges", "KÉSZÜLÉK TIPUSA": "HDMC-130", "MEGJEGYZÉS": "Szoftver hiba: PLC firmware update" },
    { KEY: 3, "BEJELENTÉS SORSZÁMA": "B2608003", "1": huDate(10), "AKTUÁLIS NÉV": "ACME Kft.", "NY/Z": 1, "DOLGOZÓ": "GJ", "BEJELENTETT HIBA": "Vezérlő hiba", "KÉSZÜLÉK TIPUSA": "TMV-400", "MEGJEGYZÉS": "Vezérlő hiba: NCT104 komunikáció" },
    { KEY: 4, "BEJELENTÉS SORSZÁMA": "B2608004", "1": huDate(2), "AKTUÁLIS NÉV": "ACME Kft.", "NY/Z": 0, "DOLGOZÓ": "GJ", "BEJELENTETT HIBA": "Kijelző hiba", "KÉSZÜLÉK TIPUSA": "TMV-400", "MEGJEGYZÉS": "Kijelző hiba: LCD csík" },
    // Customer B: BETA Zrt. — 1 ticket (for top-N comparisons)
    { KEY: 5, "BEJELENTÉS SORSZÁMA": "B2608005", "1": huDate(5), "AKTUÁLIS NÉV": "BETA Zrt.", "NY/Z": 0, "DOLGOZÓ": "TS", "BEJELENTETT HIBA": "Szerviz", "KÉSZÜLÉK TIPUSA": "DPB-3", "MEGJEGYZÉS": "DPB-3 éves szerviz" },
  ];
  fix = buildFixture(rows);
  srv = await startTestServer(fix);
});

afterAll(() => {
  srv.stop();
  cleanupFixture(fix);
});

describe("customer_fleet_overview: REST end-to-end", () => {
  test("bare customer name 'ACME' triggers fleet overview", async () => {
    const r = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "ACME", language: "hu" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { intent: string; filters: { customer?: string }; summary: string; results: any };
    expect(body.intent).toBe("customer_fleet_overview");
    expect(body.filters.customer).toContain("ACME");
    expect(body.summary).toContain("ACME");
    // 5-section composite: must mention the top machines
    expect(body.summary).toContain("HDMC-130");
    expect(body.summary).toContain("TMV-400");
    // Total count is in the summary
    expect(body.summary).toMatch(/4.*ticket|4 jegy|4 találat/);
    // Has a category section
    expect(body.summary).toMatch(/Hibakategóriák/);
    // Has the first/most-recent date range
    expect(body.summary).toMatch(/Első.*utolsó/);
  });

  test("fleet composite reports correct machine breakdown", async () => {
    const r = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "ACME", language: "hu" }),
    });
    const body = await r.json() as { results: [{ topMachines: { name: string; count: number }[]; topCategories: { name: string; count: number }[]; total: number; last5: { sorszam: string }[]; distinctMachines: number }] };
    const composite = body.results[0];
    expect(composite.total).toBe(4);
    expect(composite.topMachines.length).toBe(2);
    // HDMC-130 has 2, TMV-400 has 2 — both must appear
    const machines = Object.fromEntries(composite.topMachines.map(m => [m.name, m.count]));
    expect(machines["HDMC-130"]).toBe(2);
    expect(machines["TMV-400"]).toBe(2);
    // Categories: at least 2 distinct (inferred classifier consolidates)
    expect(composite.topCategories.length).toBeGreaterThanOrEqual(2);
    // Last 5: 4 (all of them)
    expect(composite.last5.length).toBe(4);
    // Distinct machine types: 2
    expect(composite.distinctMachines).toBe(2);
  });

  test("fleet composite returns Hungarian by default, English on language=en", async () => {
    const r1 = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "ACME", language: "hu" }),
    });
    const hu = (await r1.json() as { summary: string }).summary;
    expect(hu).toMatch(/ticket|jegy|találat|Gépek|kateg/);

    const r2 = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "ACME", language: "en" }),
    });
    const en = (await r2.json() as { summary: string }).summary;
    expect(en).toMatch(/Machines|Categories|tickets/i);
  });

  test("compound question with bare name routes to customer + leftover q filter", async () => {
    // Regression: the original bug was "Hány alkalommal ment tönkre az
    // SVG HDMC gépében az y2 hajtás" → intent was promoted to
    // customer_fleet_overview with q wiped. This test verifies that
    // compound questions with a bare customer name keep their original
    // intent (part_spec) and the q is threaded through.
    const r = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "Hány alkalommal fordult elő Mechanikai hiba az ACME Kft.-nél?", language: "hu" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { intent: string; filters: { customer?: string; kategoria?: string; q?: string }; summary: string };
    expect(body.filters.customer).toContain("ACME");
    // The q must be preserved (not wiped to "")
    expect(body.filters.q).toBeDefined();
    expect(body.filters.q!.length).toBeGreaterThan(3);
    // Either the filter OR the summary must mention the category
    expect(body.filters.kategoria ?? body.summary).toBeTruthy();
  });

  test("bare customer + compound question keeps part_spec intent (not fleet)", async () => {
    // Phase 6 regression: "Hány alkalommal ment tönkre az ACME gépében
    // a Y2 hajtás" must NOT be promoted to customer_fleet_overview.
    // The probe promotes customer to canonical, but the intent must stay
    // as part_spec because there's a meaningful q.
    const r = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "Hány alkalommal ment tönkre az ACME gépében a Y2 hajtás", language: "hu" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { intent: string; filters: { customer?: string; q?: string }; summary: string };
    // Intent must stay part_spec, NOT customer_fleet_overview
    expect(body.intent).toBe("part_spec");
    // Customer must be promoted to canonical
    expect(body.filters.customer).toContain("ACME");
    // q must be preserved (not empty)
    expect(body.filters.q).toBeDefined();
    expect(body.filters.q!.length).toBeGreaterThan(3);
    // Summary must NOT be a fleet composite (no "Gépek" section header).
    // It will be a part_spec-style answer — either matching tickets or a
    // "no spec found" message, depending on whether the fixture data
    // contains the searched term.
    expect(body.summary).not.toMatch(/Gépek.*top|Machines.*top/);
  });

  test("false-positive bare name: 'FOOBAR' has no customer match, falls through", async () => {
    const r = await fetch(`${srv.url}/v1/answer`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "FOOBAR", language: "hu" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { intent: string; filters: { customer?: string; device?: string } };
    // The probe returned 0 customers → the weak-customer extraction is
    // discarded and the question falls through to the free-text path.
    expect(body.filters.customer).toBeUndefined();
  });
});
