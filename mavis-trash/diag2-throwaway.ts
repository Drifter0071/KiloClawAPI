// Diag: directly query the seeded serviz_belso
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbs } from "../src/db/open";

describe("diag2", () => {
  test("raw LIKE check", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmms-diag2-"));
    const cmmsPath = join(dir, "cmms.db");
    const specPath = join(dir, "spec.db");
    new Database(cmmsPath);
    const dbs = openDbs({ cmmsPath, specializedPath: specPath });
    dbs.spec.exec(`CREATE TABLE serviz_belso (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      j_szam TEXT, datum_iso TEXT, cegnev TEXT, cegnev_ascii TEXT,
      eszkoz TEXT, eszkoz_ascii TEXT,
      hibajelenseg TEXT, vegzett_munka TEXT, dolgozo TEXT
    )`);
    dbs.spec.prepare(
      "INSERT INTO serviz_belso (j_szam, datum_iso, cegnev, cegnev_ascii, eszkoz, eszkoz_ascii) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("J00001", "2024-03-15", "ANDRITZ KFT.", "andritz kft.", "TMV-400(10297)", "tmv40010297");

    const r1 = dbs.spec.query(`SELECT j_szam, eszkoz_ascii FROM serviz_belso`).all();
    console.log("ALL ROWS", JSON.stringify(r1));

    const r2 = dbs.spec.query(`SELECT j_szam, eszkoz_ascii FROM serviz_belso WHERE eszkoz_ascii LIKE ?`).all(`%tmv400%`);
    console.log("LIKE %tmv400%", JSON.stringify(r2));

    const r3 = dbs.spec.query(`SELECT j_szam, eszkoz_ascii FROM serviz_belso WHERE eszkoz_ascii LIKE ?`).all(`%tmv-400%`);
    console.log("LIKE %tmv-400%", JSON.stringify(r3));

    dbs.cmms.close();
    dbs.spec.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    expect(r2.length).toBeGreaterThan(0);
  });
});
