// /v1/health, /v1/capabilities, /v1/schema, /v1/index
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";
import { startTestServer, authHeaders, type TestServer } from "./harness";

const rows: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B20010101",
    "1": "2020.11.06",
    "AKTUÁLIS NÉV": "MÁV RT. Debrecen",
    "IRSZ.": "4034",
    "CÍM": "Debrecen Faraktár u 107",
    "KÉSZÜLÉK TIPUSA": "TMV-400(10297;M10170);NCT99M;CRT15\";SW-1.039;",
    "BEJELENTETT HIBA": "telepítés üzembe helyezés",
    "ELVÉGZETT MUNKA": "üzembe helyezve, SW 1.039",
    "NY/Z": 0,
    "DOLGOZÓ": "TP;",
  },
  {
    KEY: 2,
    "BEJELENTÉS SORSZÁMA": "B20020201",
    "1": "2021.03.15",
    "AKTUÁLIS NÉV": "NÉMETH LÁSZLÓ",
    "IRSZ.": "8360",
    "CÍM": "Keszthely Külső Zsidei út 2.",
    "KÉSZÜLÉK TIPUSA": "NilesDFS-2(740 0005 22);NCT2000;CRT9\";SW-1.039;HW:int;Servok:Siemens-DC;",
    "BEJELENTETT HIBA": "készülék nem indul",
    "ELVÉGZETT MUNKA": "tápegység csere, SW frissítés",
    "NY/Z": 1,
    "DOLGOZÓ": "KF;",
  },
  {
    KEY: 3,
    "BEJELENTÉS SORSZÁMA": "B20030301",
    "1": "2022.07.22",
    "AKTUÁLIS NÉV": "GE H. Hajdúböszörmény",
    "IRSZ.": "4221",
    "CÍM": "Hajdúböszörmény Kinizsi tér 1.",
    "KÉSZÜLÉK TIPUSA": "FND32(305/0677);NCT2000M;CRT15\";SW-7.038;",
    "BEJELENTETT HIBA": "képernyő sötét",
    "ELVÉGZETT MUNKA": null,
    "NY/Z": 0,
    "DOLGOZÓ": "PI;",
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

describe("GET /v1/health", () => {
  test("no auth required", async () => {
    const r = await fetch(`${srv.url}/v1/health`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.jobs).toBe(3);
    expect(j.cmms_path).toContain("cmms.db");
  });
});

describe("GET /v1/capabilities", () => {
  test("requires read token", async () => {
    const r = await fetch(`${srv.url}/v1/capabilities`);
    expect(r.status).toBe(401);
  });
  test("returns full API surface", async () => {
    const r = await fetch(`${srv.url}/v1/capabilities`, { headers: authHeaders(srv.readToken) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.server.name).toBe("cmms-api");
    expect(j.auth.tokens.read).toBeTruthy();
    expect(j.auth.tokens.write).toBeTruthy();
    const paths = j.endpoints.map((e: any) => `${e.method} ${e.path}`);
    expect(paths).toContain("GET /v1/health");
    expect(paths).toContain("GET /v1/capabilities");
    expect(paths).toContain("GET /v1/schema");
    expect(paths).toContain("GET /v1/index");
    expect(paths).toContain("POST /v1/jobs/search");
    expect(paths).toContain("GET /v1/jobs/:key");
    expect(paths).toContain("GET /v1/jobs/:key/raw");
    expect(paths).toContain("POST /v1/jobs");
    expect(paths).toContain("POST /v1/jobs/:key/notes");
    expect(j.priority_fields.fields.length).toBe(3);
    expect(j.typical_workflows.length).toBeGreaterThan(0);
  });
});

describe("GET /v1/schema", () => {
  test("returns frozen JSON with English descriptions", async () => {
    const r = await fetch(`${srv.url}/v1/schema`, { headers: authHeaders(srv.readToken) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.version).toBe(1);
    expect(j.priority_fields.fields.length).toBe(3);
    expect(j.priority_fields.fields[0].hu).toBe("Készülék típusa");
  });
});

describe("GET /v1/index", () => {
  test("returns counts and top-N", async () => {
    const r = await fetch(`${srv.url}/v1/index`, { headers: authHeaders(srv.readToken) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.totalJobs).toBe(3);
    expect(j.statusCounts.open).toBe(2);
    expect(j.statusCounts.closed).toBe(1);
    expect(j.topModels.length).toBeGreaterThan(0);
    // MÁV RT. Debrecen should appear.
    const names = j.topCustomers.map((c: any) => c.name);
    expect(names).toContain("MÁV RT. Debrecen");
  });
});
