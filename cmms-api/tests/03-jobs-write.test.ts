// POST /v1/jobs, POST /v1/jobs/:key/notes, and the fact that they
// mirror to both the original cmms.db and the specialized DB.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";
import { startTestServer, authHeaders, type TestServer } from "./harness";

const rows: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B20010101",
    "1": "2020.11.06",
    "AKTUÁLIS NÉV": "MÁV RT. Debrecen",
    "KÉSZÜLÉK TIPUSA": "TMV-400(10297;M10170);NCT99M;SW-1.039;",
    "BEJELENTETT HIBA": "telepítés",
    "NY/Z": 0,
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

describe("POST /v1/jobs", () => {
  test("creates a job and mirrors to cmms.db", async () => {
    const r = await fetch(`${srv.url}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({
        customer: { name: "TEST CUST KFT.", zip: "1111", address: "Budapest Fő utca 1.", phone: "+3612345678" },
        devices: ["TMV-400(10297);SW-2.001", "NCT2000"],
        reported: "készülék nem indul el",
        work: "SW frissítés 2.001-re",
        technician: "TS",
      }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.key).toBeGreaterThan(1);
    expect(j.sorszam).toMatch(/^B\d{4}\d{3}$/);
    expect(j.status).toBe("open");
    expect(j.customer.name).toBe("TEST CUST KFT.");
    expect(j.devices.length).toBe(3);
    expect(j.devices[0].model).toBe("TMV-400");
    expect(j.devices[1].model).toBe("SW-2.001");
    expect(j.devices[1].software).toBe("2.001");
    expect(j.devices[2].model).toBe("NCT2000");
    const reported = j.notes.find((n: any) => n.kind === "reported");
    const work = j.notes.find((n: any) => n.kind === "work");
    expect(reported?.body).toBe("készülék nem indul el");
    expect(work?.body).toBe("SW frissítés 2.001-re");

    // Verify cmms.db has the new row with the right columns.
    const cmms = new Database(fix.cmmsPath, { readonly: true });
    const row = cmms.prepare(`SELECT * FROM data WHERE "KEY" = ?`).get(j.key) as any;
    cmms.close();
    expect(row["AKTUÁLIS NÉV"]).toBe("TEST CUST KFT.");
    expect(row["NY/Z"]).toBe(1); // Phase 3 polarity fix: 1 = open
    expect(row["BEJELENTÉS SORSZÁMA"]).toBe(j.sorszam);
    expect(row["KÉSZÜLÉK TIPUSA"]).toBe("TMV-400(10297);SW-2.001;NCT2000");
    if (!j || !row) {
      // eslint-disable-next-line no-console
      console.error("create failed", { j, row });
    }
    expect(row["BEJELENTETT HIBA"]).toBe("készülék nem indul el");
    expect(row["ELVÉGZETT MUNKA"]).toBe("SW frissítés 2.001-re");
  });

  test("missing customer.name -> 400", async () => {
    const r = await fetch(`${srv.url}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ reported: "x" }),
    });
    expect(r.status).toBe(400);
  });

  test("missing reported -> 400", async () => {
    const r = await fetch(`${srv.url}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ customer: { name: "X" } }),
    });
    expect(r.status).toBe(400);
  });

  test("newly created job is searchable", async () => {
    const r = await fetch(`${srv.url}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({
        customer: { name: "SEARCHABLE CUST" },
        devices: ["UNIQUE-MODEL-XYZ"],
        reported: "is-this-found",
      }),
    });
    const j = await r.json();
    expect(r.status).toBe(201);
    const s = await fetch(`${srv.url}/v1/jobs/search`, {
      method: "POST",
      headers: authHeaders(srv.readToken),
      body: JSON.stringify({ q: "unique-model-xyz" }),
    });
    expect(s.status).toBe(200);
    const sj = await s.json();
    expect(sj.jobs.some((x: any) => x.key === j.key)).toBe(true);
  });
});

describe("POST /v1/jobs/:key/notes", () => {
  test("appends work note, mirrors to cmms.db MEGJEGYZÉS via append", async () => {
    const r = await fetch(`${srv.url}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({
        customer: { name: "NOTE TEST" },
        reported: "fault",
        work: "fix-A",
      }),
    });
    const j = await r.json();

    const n = await fetch(`${srv.url}/v1/jobs/${j.key}/notes`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ kind: "free", body: "follow-up: re-tested", author: "TS" }),
    });
    expect(n.status).toBe(201);
    const nj = await n.json();
    expect(nj.notes.length).toBe(j.notes.length + 1);
    expect(nj.notes[nj.notes.length - 1].body).toBe("follow-up: re-tested");
    expect(nj.notes[nj.notes.length - 1].author).toBe("TS");

    // cmms.db MEGJEGYZÉS now has the appended line.
    const cmms = new Database(fix.cmmsPath, { readonly: true });
    const row = cmms.prepare(`SELECT "MEGJEGYZÉS" AS m FROM data WHERE "KEY" = ?`).get(j.key) as any;
    cmms.close();
    expect(String(row.m)).toMatch(/follow-up: re-tested/);
  });

  test("appending kind=work appends to ELVÉGZETT MUNKA with separator", async () => {
    const r = await fetch(`${srv.url}/v1/jobs`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({
        customer: { name: "WORK APPEND" },
        reported: "fault",
        work: "first fix",
      }),
    });
    const j = await r.json();

    await fetch(`${srv.url}/v1/jobs/${j.key}/notes`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ kind: "work", body: "second fix", author: "TS" }),
    });

    const cmms = new Database(fix.cmmsPath, { readonly: true });
    const row = cmms.prepare(`SELECT "ELVÉGZETT MUNKA" AS w FROM data WHERE "KEY" = ?`).get(j.key) as any;
    cmms.close();
    expect(String(row.w)).toContain("first fix");
    expect(String(row.w)).toContain("second fix");
  });

  test("bad kind -> 400", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/1/notes`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ kind: "bogus", body: "x" }),
    });
    expect(r.status).toBe(400);
  });

  test("missing body -> 400", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/1/notes`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ kind: "work" }),
    });
    expect(r.status).toBe(400);
  });

  test("404 for unknown key", async () => {
    const r = await fetch(`${srv.url}/v1/jobs/9999/notes`, {
      method: "POST",
      headers: authHeaders(srv.writeToken),
      body: JSON.stringify({ kind: "work", body: "x" }),
    });
    expect(r.status).toBe(404);
  });
});
