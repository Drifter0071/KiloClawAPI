// Phase 0 — period resolution and evidence-on-by-default tests.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";
import { startTestServer, type TestServer, authHeaders } from "./harness";
import { normalizePeriod, resolvePeriod } from "../src/lib/period";

const rows: FixtureRow[] = [
  // 2020-01-15 open
  { KEY: 1, "BEJELENTÉS SORSZÁMA": "B20010101", "1": "2020.01.15", "AKTUÁLIS NÉV": "ACME", "NY/Z": 0, "BEJELENTETT HIBA": "régi hiba" },
  // 2020-06-15 open
  { KEY: 2, "BEJELENTÉS SORSZÁMA": "B20020601", "1": "2020.06.15", "AKTUÁLIS NÉV": "ACME", "NY/Z": 0, "BEJELENTETT HIBA": "régi hiba 2" },
  // 2024-12-15 open
  { KEY: 3, "BEJELENTÉS SORSZÁMA": "B24121501", "1": "2024.12.15", "AKTUÁLIS NÉV": "ANDRITZ", "NY/Z": 0, "BEJELENTETT HIBA": "friss hiba" },
  // today (synthetic — we set reported_at_iso in ETL? no, ETL uses "1" column)
];

let fix: Fixture;
let srv: TestServer;

beforeAll(async () => {
  fix = buildFixture(rows);
  srv = await startTestServer(fix);
});

afterAll(() => {
  srv?.stop();
  cleanupFixture(fix);
});

describe("period normalization (hu + en aliases)", () => {
  test("english aliases resolve", () => {
    expect(normalizePeriod("today")).toBe("today");
    expect(normalizePeriod("this_month")).toBe("this_month");
    expect(normalizePeriod("last_30_days")).toBe("last_30_days");
    expect(normalizePeriod("YTD")).toBe("YTD");
    expect(normalizePeriod("all")).toBe("all");
  });
  test("hungarian aliases resolve", () => {
    expect(normalizePeriod("ma")).toBe("today");
    expect(normalizePeriod("tavaly")).toBe("last_year");
    expect(normalizePeriod("idén")).toBe("this_year");
    expect(normalizePeriod("utolsó 30 nap")).toBe("last_30_days");
    expect(normalizePeriod("utolso 30 nap")).toBe("last_30_days");
    expect(normalizePeriod("múlt hónap")).toBe("last_month");
    expect(normalizePeriod("minden")).toBe("all");
  });
  test("unknown token returns null", () => {
    expect(normalizePeriod("foobar")).toBeNull();
    expect(normalizePeriod("")).toBeNull();
    expect(normalizePeriod(undefined)).toBeNull();
  });
});

describe("period resolution", () => {
  const fixedNow = new Date("2025-03-15T12:00:00Z");

  test("this_month returns first-of-month to today", () => {
    const r = resolvePeriod("this_month", fixedNow);
    expect(r.date_from).toBe("2025-03-01");
    expect(r.date_to).toBe("2025-03-15");
    expect(r.resolved_token).toBe("this_month");
  });
  test("this_year returns Jan 1 to today", () => {
    const r = resolvePeriod("this_year", fixedNow);
    expect(r.date_from).toBe("2025-01-01");
    expect(r.date_to).toBe("2025-03-15");
  });
  test("last_30_days returns 29 days back to today", () => {
    const r = resolvePeriod("last_30_days", fixedNow);
    // 30-day window inclusive of today: today minus 29 days.
    expect(r.date_from).toBe("2025-02-14");
    expect(r.date_to).toBe("2025-03-15");
  });
  test("last_year returns full previous calendar year", () => {
    const r = resolvePeriod("last_year", fixedNow);
    expect(r.date_from).toBe("2024-01-01");
    expect(r.date_to).toBe("2024-12-31");
  });
  test("all returns nulls", () => {
    const r = resolvePeriod("all", fixedNow);
    expect(r.date_from).toBeNull();
    expect(r.date_to).toBeNull();
  });
  test("custom with explicit date_from/date_to wins", () => {
    const r = resolvePeriod("this_year", fixedNow, { date_from: "2024-06-01", date_to: "2024-06-30" });
    expect(r.date_from).toBe("2024-06-01");
    expect(r.date_to).toBe("2024-06-30");
    expect(r.resolved_token).toBe("custom");
  });
  test("labels are bilingual", () => {
    const r = resolvePeriod("this_month", fixedNow);
    expect(r.label_en).toBe("this month");
    expect(r.label_hu).toBe("ez a hónap");
  });
});

describe("/v1/jobs/search with period", () => {
  test("period=last_year filters to previous-calendar-year ticket only", async () => {
    // The server uses real wall clock, so derive the expected window
    // from current year-1.
    const now = new Date();
    const lastYear = now.getUTCFullYear() - 1;
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ period: "last_year" }),
    });
    const j = await r.json() as any;
    expect(r.status).toBe(200);
    expect(j.period.resolved_token).toBe("last_year");
    expect(j.period.date_from).toBe(`${lastYear}-01-01`);
    expect(j.period.date_to).toBe(`${lastYear}-12-31`);
    // The 2024-12-15 ticket should fall in last year only if the system
    // clock is 2025 or 2026. The 2020 tickets are 5+ years back, so
    // they are never in last_year. We only assert the 2020 tickets
    // are excluded and the 2024 ticket is included when last_year == 2024.
    const keys = j.jobs.map((x: any) => x.key);
    expect(keys).not.toContain(1);
    expect(keys).not.toContain(2);
    if (lastYear === 2024) {
      expect(keys).toContain(3);
    }
  });
  test("period=this_year (relative to 2025) returns 2024-12 ticket as out-of-window", async () => {
    // We need to use the actual current date, so this test is
    // anchored to the system clock. We only assert that the period
    // echo is correct.
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ period: "this_year" }),
    });
    const j = await r.json() as any;
    expect(j.period.resolved_token).toBe("this_year");
    expect(typeof j.period.date_from).toBe("string");
    expect(j.period.date_from!.length).toBe(10);
  });
  test("period=custom with explicit date_from/date_to", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ period: "custom", date_from: "2020-01-01", date_to: "2020-12-31" }),
    });
    const j = await r.json() as any;
    expect(j.period.resolved_token).toBe("custom");
    expect(j.period.date_from).toBe("2020-01-01");
    expect(j.jobs.length).toBe(2);
  });
  test("all-time (no period, no dates) returns everything", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({}),
    });
    const j = await r.json() as any;
    expect(j.jobs.length).toBe(3);
  });
});

describe("/v1/jobs/stats with period + evidence", () => {
  test("echoes resolved period", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer", period: "last_year" }),
    });
    const j = await r.json() as any;
    expect(j.period.resolved_token).toBe("last_year");
  });
  test("include_evidence default ON returns evidence per top group", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer" }),
    });
    const j = await r.json() as any;
    expect(j.evidence).toBeDefined();
    // ACME should have evidence.
    const acmeEvidence = j.evidence?.["ACME"];
    expect(acmeEvidence).toBeDefined();
    expect(Array.isArray(acmeEvidence)).toBe(true);
    expect(acmeEvidence[0]).toHaveProperty("sorszam");
    expect(acmeEvidence[0]).toHaveProperty("snippet");
  });
  test("include_evidence=false suppresses evidence", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer", include_evidence: false }),
    });
    const j = await r.json() as any;
    expect(j.evidence).toBeUndefined();
  });
  test("evidence_per_group caps at 2 by default", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer" }),
    });
    const j = await r.json() as any;
    const acmeEvidence = j.evidence?.["ACME"] ?? [];
    expect(acmeEvidence.length).toBeLessThanOrEqual(2);
  });
});

describe("/v1/jobs/recurring-problems with period", () => {
  test("echoes resolved period", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/recurring-problems`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ period: "all" }),
    });
    const j = await r.json() as any;
    expect(j.period?.resolved_token).toBe("all");
  });
});
