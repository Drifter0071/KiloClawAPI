// Diag3: trace the exact row that fails
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbs } from "../src/db/open";
import { JobCache } from "../src/cache/jobs";

describe("diag3", () => {
  test("trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmms-diag3-"));
    const cmmsPath = join(dir, "cmms.db");
    const specPath = join(dir, "spec.db");
    new Database(cmmsPath);
    const dbs = openDbs({ cmmsPath, specializedPath: specPath });
    const r = { KEY: 1, customer_id: 1, "AKTUÁLIS NÉV": "X Kft.", "BEJELENTÉS SORSZÁMA": "B2408001", "1": "2024-08-15" };
    console.log("SORSZAM VALUE:", JSON.stringify(r["BEJELENTÉS SORSZÁMA"]));
    console.log("TYPEOF:", typeof r["BEJELENTÉS SORSZÁMA"]);
    console.log("KEYS:", Object.keys(r));
    dbs.spec.prepare(`INSERT OR REPLACE INTO customers (id, name, name_ascii) VALUES (?, ?, ?)`).run(r.customer_id, r["AKTUÁLIS NÉV"], String(r["AKTUÁLIS NÉV"]).toLowerCase());
    dbs.spec.prepare(`INSERT OR REPLACE INTO jobs (key, sorszam, reported_at, reported_at_iso, customer_id, technician, status, problem_kategoria, problem_alkategoria, sulyossag, kategoria_inferred, kategoria_inferred_conf, sulyossag_inferred, sulyossag_inferred_conf, alkategoria_inferred, resolution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      r.KEY, r["BEJELENTÉS SORSZÁMA"], r["1"], r["1"], r.customer_id,
      r["TECHNIKUS"] ?? null, 1, null, null, null,
      null, null, null, null, null, "open"
    );
    console.log("INSERT OK");
    dbs.cmms.close();
    dbs.spec.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    expect(true).toBe(true);
  });
});
