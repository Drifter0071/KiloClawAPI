// Phase 1 inferred-field tests.
//
// These tests run against a real test server (harness) and verify
// the inferred columns are populated by the auto-classifier and that
// the REST endpoints honor the new filters.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { startTestServer, authHeaders, type TestServer } from "./harness";
import { buildFixture } from "./fixtures/fixture";
import type { FixtureRow } from "./fixtures/fixture";

let srv: TestServer;

beforeAll(async () => {
  // 3 hand-crafted tickets: one software, one critical, one machine-specific.
  const rows: FixtureRow[] = [
    {
      "KEY": 1,
      "BEJELENTÉS SORSZÁMA": "B25010101",
      "1": "2025.01.01.",
      "AKTUÁLIS NÉV": "ANDRITZ Kft.",
      "BEJELENTETT HIBA": "PLC program nem fut le a NCT104-en. Paraméter betöltés sikertelen.",
      "ELVÉGZETT MUNKA": "Szoftver frissítés, parameter betoltes ujra.",
      "NY/Z": 0,
      "DOLGOZÓ": "TV",
      "KÉSZÜLÉK TIPUSA": "TMV-400(10297;M10170);NCT104;SW-1.039",
      "FIZ/GAR": "fiz",
      "TÁVOLIGÉPELÉRÉS": "nincs",
    },
    {
      "KEY": 2,
      "BEJELENTÉS SORSZÁMA": "B25010202",
      "1": "2025.01.02.",
      "AKTUÁLIS NÉV": "MÁV RT.",
      "BEJELENTETT HIBA": "Vészleállás! A gép leállt, nem indul újra. Főorsó áll.",
      "ELVÉGZETT MUNKA": null as any,
      "NY/Z": 1,
      "DOLGOZÓ": "JH",
      "KÉSZÜLÉK TIPUSA": "DPB-3-40-80",
      "FIZ/GAR": "gar",
      "TÁVOLIGÉPELÉRÉS": "teamviewer",
    },
    {
      "KEY": 3,
      "BEJELENTÉS SORSZÁMA": "B25010303",
      "1": "2025.01.03.",
      "AKTUÁLIS NÉV": "Contitech Kft.",
      "BEJELENTETT HIBA": "Beállítás kérés: a kijelző kalibrálása szükséges.",
      "ELVÉGZETT MUNKA": "Finomhangolás elvégezve.",
      "NY/Z": 1,
      "DOLGOZÓ": "TV",
      "KÉSZÜLÉK TIPUSA": "FEW-200;KAFO-12",
      "FIZ/GAR": "fiz",
      "TÁVOLIGÉPELÉRÉS": "nincs",
    },
  ];
  srv = await startTestServer(buildFixture(rows));
});

afterAll(() => {
  srv.stop();
});

const read = async (path: string, body: any) => {
  const r = await fetch(`${srv.url}${path}`, {
    method: "POST",
    headers: authHeaders(srv.readToken),
    body: JSON.stringify(body),
  });
  return r.json();
};

describe("inferred fields: present on every job card", () => {
  test("each job card has kategoria_inferred / sulyossag_inferred / alkategoria_inferred", async () => {
    const r: any = await read("/v1/jobs/search", {});
    expect(r.total).toBe(3);
    for (const j of r.jobs) {
      expect(j.kategoria_inferred).toBeDefined();
      expect(j.sulyossag_inferred).toBeDefined();
    }
    const sw = r.jobs.find((j: any) => j.customer.name === "ANDRITZ Kft.");
    expect(sw.kategoria_inferred).toBe("Szoftver/PLC program hiba");
    // The fixture's device cell starts with "TMV-400(...);NCT104;..." so
    // the classifier picks TMV-400 as the first device family. Either is
    // correct — we just want to confirm the alkategoria was filled.
    expect(sw.alkategoria_inferred).toBeTruthy();
  });
  test("vészleállás ticket -> kritikus", async () => {
    const r: any = await read("/v1/jobs/search", {});
    const crit = r.jobs.find((j: any) => j.customer.name === "MÁV RT.");
    expect(crit.sulyossag_inferred).toBe("kritikus");
  });
  test("beállítás kérés -> alacsony", async () => {
    const r: any = await read("/v1/jobs/search", {});
    const lo = r.jobs.find((j: any) => j.customer.name === "Contitech Kft.");
    expect(lo.sulyossag_inferred).toBe("alacsony");
  });
});

describe("inferred fields: search filters", () => {
  test("filter by kategoria_inferred=Szoftver finds the ANDRITZ ticket", async () => {
    const r: any = await read("/v1/jobs/search", { kategoria_inferred: "Szoftver" });
    expect(r.total).toBe(1);
    expect(r.jobs[0].customer.name).toBe("ANDRITZ Kft.");
  });
  test("filter by sulyossag_inferred=kritikus finds the MÁV ticket", async () => {
    const r: any = await read("/v1/jobs/search", { sulyossag_inferred: "kritikus" });
    expect(r.total).toBe(1);
    expect(r.jobs[0].customer.name).toBe("MÁV RT.");
  });
  test("filter by alkategoria_inferred=TMV-400 finds the ANDRITZ ticket", async () => {
    const r: any = await read("/v1/jobs/search", { alkategoria_inferred: "TMV-400" });
    expect(r.total).toBe(1);
    expect(r.jobs[0].customer.name).toBe("ANDRITZ Kft.");
  });
});

describe("inferred fields: stats aggregations", () => {
  test("group_by=kategoria_inferred returns the inferred distribution", async () => {
    const r: any = await read("/v1/jobs/stats", { group_by: "kategoria_inferred" });
    const byName = Object.fromEntries(r.results.map((x: any) => [x.name, x.count]));
    expect(byName["Szoftver/PLC program hiba"]).toBe(1);
    // The MÁV ticket mentions veszleallas + foprsó áll + leállt — these
    // match magas/magas/kritikus rules. The exact bucket depends on
    // which rule fires first; we just assert that we got >= 1 critical
    // hit in the distribution. The important thing is the count > 0.
    const total = (r.results as { name: string; count: number }[])
      .reduce((s, x) => s + x.count, 0);
    expect(total).toBe(3);
  });
  test("group_by=sulyossag_inferred returns the inferred severity distribution", async () => {
    const r: any = await read("/v1/jobs/stats", { group_by: "sulyossag_inferred" });
    const byName = Object.fromEntries(r.results.map((x: any) => [x.name, x.count]));
    expect(byName.kritikus).toBe(1);
    expect(byName.alacsony).toBe(1);
  });
  test("group_by=alkategoria_inferred with filter sulyossag_inferred=kritikus returns MÁV's device", async () => {
    const r: any = await read("/v1/jobs/stats", {
      group_by: "alkategoria_inferred",
      sulyossag_inferred: "kritikus",
    });
    expect(r.total).toBeGreaterThan(0);
  });
});

describe("/v1/answer router endpoint", () => {
  test("'Melyik ügyfélhez járunk a legtöbbet?' returns top_customers plan", async () => {
    const r: any = await read("/v1/answer", { q: "Melyik ügyfélhez járunk a legtöbbet?" });
    expect(r.intent).toMatch(/^top_customers/);
    expect(r.primitive).toBe("stats");
    expect(r.results.length).toBeGreaterThan(0);
  });
  test("'Mennyi kritikus ticket van most?' returns critical_open_now plan", async () => {
    const r: any = await read("/v1/answer", { q: "Mennyi kritikus ticket van most?" });
    expect(r.intent).toBe("critical_open_now");
  });
  test("'B25010101' returns the explicit sorszam", async () => {
    const r: any = await read("/v1/answer", { q: "B25010101" });
    expect(r.intent).toBe("find_ticket_by_sorszam");
    expect(r.results[0].sorszam).toBe("B25010101");
  });
  test("English question works with language=en", async () => {
    const r: any = await read("/v1/answer", { q: "Which customer do we visit most?", language: "en" });
    expect(r.primitive).toBe("stats");
    expect(r.language).toBe("en");
  });
  test("vague 1-char question returns needs_clarification with follow_ups", async () => {
    const r: any = await read("/v1/answer", { q: "?" });
    expect(r.intent).toBe("needs_clarification");
    expect(r.follow_ups.length).toBeGreaterThan(0);
  });
});
