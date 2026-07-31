// Build a fresh cmms.db (mirror of the real schema) populated with
// a small fixture, plus the cmms_specialized.db is built on demand by
// the test harness. Returns the absolute paths.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const COLUMNS = [
  "KEY",
  "BEJELENTÉS SORSZÁMA",
  "1",
  "AKTUÁLIS NÉV",
  "RÉGI NÉV",
  "IRSZ.",
  "CÍM",
  "TELEFON",
  "E-MAIL",
  "BEJELENTŐ",
  "HIBAFELVEVŐ",
  "KÉSZÜLÉK TIPUSA",
  "BEJELENTETT HIBA",
  "ELVÉGZETT MUNKA",
  "FIZ/GAR",
  "ÜH. GARANCIA",
  "NY/Z",
  "TERV",
  "TÁVOLIGÉPELÉRÉS",
  "ELKÉSZÜLÉS",
  "DOLGOZÓ",
  "MEGJEGYZÉS",
  "SZERV LAP",
  "SZL",
  "SZÁMLA",
  "PAR_PLC",
  "BEÉRKEZŐ KÉPEK",
  "KIMENŐ KÉPEK",
  "ÜGYFELEK KÉPEI",
  "RV",
  "VS MEO DÁTUM",
  "VS MEO CSOPORT",
  "VS MEO FELELŐS",
  "VS MEO HELYZET",
  "VS MEO FELADAT / KÉRÉS",
  "VS MEO NY/Z \n0/1 Z/NY\n3/4 üf.-re szűrés Z/NY\n5/6 üh.-ra szűrés Z/NY",
  "Nyitott bejelentések mail",
  "field37",
  "field38",
  "field39",
  "field40",
  "field41",
];

const PLACEHOLDER_FOR = COLUMNS.map((c) => (c === "KEY" ? "?" : "NULL")).join(", ");

export type FixtureRow = {
  KEY: number;
  "BEJELENTÉS SORSZÁMA": string;
  "1": string;
  "AKTUÁLIS NÉV": string;
  "IRSZ."?: string;
  "CÍM"?: string;
  "TELEFON"?: string;
  "E-MAIL"?: string;
  "BEJELENTETT HIBA"?: string;
  "ELVÉGZETT MUNKA"?: string;
  "NY/Z"?: number;
  "DOLGOZÓ"?: string;
  "MEGJEGYZÉS"?: string;
  "KÉSZÜLÉK TIPUSA"?: string;
  [k: string]: any;
};

export type Fixture = {
  dir: string;
  cmmsPath: string;
  specPath: string;
  rows: FixtureRow[];
};

export function buildFixture(rows: FixtureRow[]): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "cmms-api-test-"));
  const cmmsPath = join(dir, "cmms.db");
  const specPath = join(dir, "cmms_specialized.db");
  const db = new Database(cmmsPath);
  // Create the data table with quoted Hungarian column names. The real
  // sheet uses lowercase for some and uppercase for others; SQLite is
  // case-sensitive on identifiers when quoted. We mirror by quoting all.
  const colsSql = COLUMNS.map((c) => `"${c}"`).join(", ");
  db.exec(`CREATE TABLE data (${colsSql})`);
  const insert = db.prepare(`INSERT INTO data ("KEY") VALUES (?)`);
  for (const r of rows) {
    insert.run(r.KEY);
    for (const [k, v] of Object.entries(r)) {
      if (k === "KEY") continue;
      if (v == null) continue;
      db.prepare(`UPDATE data SET "${k}" = ? WHERE "KEY" = ?`).run(v, r.KEY);
    }
  }
  // Mirror any other columns with default NULL? Already null from CREATE.
  // Done.
  db.close();
  return { dir, cmmsPath, specPath, rows };
}

export function cleanupFixture(f: Fixture) {
  try {
    rmSync(f.dir, { recursive: true, force: true });
  } catch {}
}
