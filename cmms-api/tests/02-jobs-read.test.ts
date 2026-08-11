// Auth, search, get, get-raw
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";
import { startTestServer, authHeaders, type TestServer } from "./harness";

const rows: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B20010101",
    "1": "2020.11.06",
    "AKTUÁLIS NÉV": "MÁV RT. Debrecen",
    "CÍM": "Debrecen Faraktár u 107",
    "KÉSZÜLÉK TIPUSA": "TMV-400(10297;M10170);NCT99M;CRT15\";SW-1.039;",
    "BEJELENTETT HIBA": "telepítés üzembe helyezés",
    "ELVÉGZETT MUNKA": "üzembe helyezve",
    "NY/Z": 1, // Phase 3 polarity fix: 1=open
    "DOLGOZÓ": "TP;",
  },
  {
    KEY: 2,
    "BEJELENTÉS SORSZÁMA": "B20020201",
    "1": "2021.03.15",
    "AKTUÁLIS NÉV": "NÉMETH LÁSZLÓ",
    "CÍM": "Keszthely",
    "KÉSZÜLÉK TIPUSA": "NilesDFS-2;NCT2000;SW-1.039;HW:int;",
    "BEJELENTETT HIBA": "készülék nem indul",
    "ELVÉGZETT MUNKA": "tápegység csere",
    "NY/Z": 0, // Phase 3 polarity fix: 0=closed
  },
  {
    KEY: 3,
    "BEJELENTÉS SORSZÁMA": "B20030301",
    "1": "2022.07.22",
    "AKTUÁLIS NÉV": "GE H. Hajdúböszörmény",
    "CÍM": "Hajdúböszörmény Kinizsi tér 1.",
    "KÉSZÜLÉK TIPUSA": "FND32;NCT2000M;SW-7.038;",
    "BEJELENTETT HIBA": "képernyő sötét",
    "NY/Z": 1, // Phase 3 polarity fix: 1=open
  },
];

let fix: Fixture;
let srv: TestServer;

beforeAll(async () => {
  fix = buildFixture(rows);
  srv = await startTestServer(fix);
});
afterAll(() => {
  srv.stop();
  cleanupFixture(fix);
});

describe("auth", () => {
  test("missing token -> 401", async () => {
    const r = await fetch(`${srv.url}/v1/schema`);
    expect(r.status).toBe(401);
    const j = await r.json();
    expect(j.error.code).toBe("unauthorized");
  });
  test("wrong token -> 401", async () => {
    const r = await fetch(`${srv.url}/v1/schema`, { headers: authHeaders("nope") });
    expect(r.status).toBe(401);
  });
  test("read token works on read endpoints", async () => {
    const r = await fetch(`${srv.url}/v1/index`, { headers: authHeaders(srv.readToken) });
    expect(r.status).toBe(200);
  });
  test("read token blocked on write endpoints -> 403", async () => {
    const r = await fetch(`${srv.url}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ customer: { name: "X" }, reported: "x" }),
    });
    expect(r.status).toBe(403);
  });
  // The "write token works" case is covered by tests/03-jobs-write.test.ts
  // which creates real jobs. We don't repeat that here because it would
  // leak state into the read tests.
});

describe("POST /v1/jobs/search", () => {
  test("q matches device model", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "TMV-400", limit: 5 }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.total).toBe(1);
    expect(j.jobs[0].sorszam).toBe("B20010101");
  });

  test("q matches Hungarian accented text in 'reported' note (diacritic folding)", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "keszulek" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.jobs.some((x: any) => x.key === 2)).toBe(true);
  });

  test("q matches accented input as-is", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "készülék" }),
    });
    const j = await r.json();
    expect(j.jobs.some((x: any) => x.key === 2)).toBe(true);
  });

  test("device filter", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ device: "NCT2000" }),
    });
    const j = await r.json();
    expect(j.jobs.length).toBe(2);
    const keys = j.jobs.map((x: any) => x.key).sort();
    expect(keys).toEqual([2, 3]);
  });

  test("status filter open vs closed", async () => {
    const r1 = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ status: "open" }),
    });
    const j1 = await r1.json();
    expect(j1.jobs.length).toBe(2);
    expect(j1.jobs.every((x: any) => x.status === "open")).toBe(true);

    const r2 = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ status: "closed" }),
    });
    const j2 = await r2.json();
    expect(j2.jobs.length).toBe(1);
    expect(j2.jobs[0].key).toBe(2);
  });

  test("date range", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ date_from: "2021-01-01", date_to: "2021-12-31" }),
    });
    const j = await r.json();
    expect(j.jobs.length).toBe(1);
    expect(j.jobs[0].key).toBe(2);
  });

  test("limit cap (default 20, max 100)", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ limit: 999 }),
    });
    const j = await r.json();
    expect(j.jobs.length).toBeLessThanOrEqual(100);
  });

  test("customer filter", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ customer: "GE" }),
    });
    const j = await r.json();
    expect(j.jobs.length).toBe(1);
    expect(j.jobs[0].key).toBe(3);
  });
});

describe("GET /v1/jobs/:key", () => {
  test("returns JobCard", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/1`, { headers: authHeaders(srv.readToken) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.key).toBe(1);
    expect(j.sorszam).toBe("B20010101");
    expect(j.status).toBe("open");
    expect(j.customer.name).toBe("MÁV RT. Debrecen");
    expect(j.devices.length).toBeGreaterThan(0);
    expect(j.devices[0].model).toBe("TMV-400");
    const sw = j.devices.find((d: any) => d.software === "1.039");
    expect(sw).toBeTruthy();
    expect(j.notes.length).toBeGreaterThan(0);
    expect(j.notes.some((n: any) => n.kind === "reported" && n.body.includes("telepítés"))).toBe(true);
  });

  test("404 for missing key", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/9999`, { headers: authHeaders(srv.readToken) });
    expect(r.status).toBe(404);
  });

  test("400 for non-numeric key", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/abc`, { headers: authHeaders(srv.readToken) });
    expect(r.status).toBe(400);
  });
});

describe("POST /v1/jobs/stats", () => {
  test("group_by customer returns correct counts", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.group_by).toBe("customer");
    expect(j.total).toBe(3);
    // All 3 customers have exactly 1 ticket each
    expect(j.results.every((x: any) => x.count === 1)).toBe(true);
    const names = j.results.map((x: any) => x.name).sort();
    expect(names).toEqual(["GE H. Hajdúböszörmény", "MÁV RT. Debrecen", "NÉMETH LÁSZLÓ"]);
  });

  test("group_by customer defaults when group_by omitted", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.group_by).toBe("customer");
    expect(j.total).toBe(3);
  });

  test("group_by status counts open vs closed", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "status" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.group_by).toBe("status");
    const openEntry = j.results.find((x: any) => x.name === "open");
    const closedEntry = j.results.find((x: any) => x.name === "closed");
    expect(openEntry?.count).toBe(2);
    expect(closedEntry?.count).toBe(1);
  });

  test("group_by device counts device occurrences", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "device" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.group_by).toBe("device");
    // Fixture row 1: TMV-400, NCT99M, CRT15; row 2: NilesDFS-2, NCT2000; row 3: FND32, NCT2000M
    const nct2000 = j.results.find((x: any) => x.name === "NCT2000");
    expect(nct2000?.count).toBe(1);
    const tmv = j.results.find((x: any) => x.name === "TMV-400");
    expect(tmv?.count).toBe(1);
  });

  test("group_by technician counts per technician", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "technician" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.group_by).toBe("technician");
    // Only key 1 has DOLGOZÓ = "TP;"
    const tp = j.results.find((x: any) => x.name === "TP;");
    expect(tp?.count).toBe(1);
    // Keys 2 and 3 have no technician
    expect(j.total).toBe(1);
  });

  test("group_by month counts by YYYY-MM", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "month" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.group_by).toBe("month");
    expect(j.total).toBe(3);
    // Each fixture row is in a different month
    expect(j.results.every((x: any) => x.count === 1)).toBe(true);
  });

  test("customer filter narrows before aggregation", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer", customer: "GE" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.total).toBe(1);
    expect(j.results[0].name).toBe("GE H. Hajdúböszörmény");
    expect(j.results[0].count).toBe(1);
  });

  test("status filter narrows before aggregation", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer", status: "open" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    // Keys 1 and 3 are open
    expect(j.total).toBe(2);
    const names = j.results.map((x: any) => x.name).sort();
    expect(names).toEqual(["GE H. Hajdúböszörmény", "MÁV RT. Debrecen"]);
  });

  test("date_from and date_to filter correctly", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer", date_from: "2021-01-01", date_to: "2021-12-31" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.total).toBe(1);
    expect(j.results[0].name).toBe("NÉMETH LÁSZLÓ");
  });

  test("q filter with free text narrows before aggregation", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer", q: "NCT2000" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    // Keys 2 (NCT2000) and 3 (NCT2000M — folded "nct2000m" includes "nct2000")
    expect(j.total).toBe(2);
  });

  test("limit caps results", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer", limit: 2 }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.results.length).toBeLessThanOrEqual(2);
  });

  test("results are sorted descending by count", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "status" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    for (let i = 1; i < j.results.length; i++) {
      expect(j.results[i].count).toBeLessThanOrEqual(j.results[i - 1].count);
    }
  });

  test("invalid group_by returns 400", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "invalid" }),
    });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("bad_group_by");
  });

  test("device filter narrows before aggregation", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/stats`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ group_by: "customer", device: "NCT2000" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    // Keys 2 (NilesDFS-2;NCT2000) and 3 (FND32;NCT2000M) have NCT2000
    expect(j.total).toBe(2);
  });
});

describe("GET /v1/jobs/:key/raw", () => {
  test("returns untouched original row", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/2/raw`, { headers: authHeaders(srv.readToken) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j["KEY"]).toBe(2);
    expect(j["AKTUÁLIS NÉV"]).toBe("NÉMETH LÁSZLÓ");
    expect(j["BEJELENTETT HIBA"]).toBe("készülék nem indul");
  });
});
