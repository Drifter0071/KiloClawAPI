// One-shot ETL that ingests the Hungarian Excel CSV exports from
// ../newIntegrationCSVs/ into:
//
//   1. cmms.db         — raw _v_<name> tables (one per source file).
//                        Mirrors the source 1:1 so an AI can read the
//                        full text of any cell, with one extra column
//                        per table: source_file + a diacritic-folded
//                        *_ascii variant on every text column the AI
//                        will search by.
//
//   2. cmms_specialized.db — curated, normalized, FTS-indexed views:
//                          serviz_belso, szev_igeny, telephely_munka,
//                          telephely_ais_motor, nem_javitjuk, statisztika.
//
// The two DBs together give the MCP server a "see the raw source" path
// and a "fast filtered search" path. The REST routes added alongside
// hit the specialized DB; a future "show me the raw row" tool can hit
// the cmms.db tables directly.
//
// Idempotent: drops and recreates all integration tables every run.

import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { parseCsv, normalizeDate, normalizeNumber, normalizeBool, type CsvRow } from "./csv";
import { fold } from "./parse";

// --- Source-file registry ----------------------------------------------------
//
// The 19 files we'll load. Per-file options:
//   skipRows:           skip N rows before the real header (title lines)
//   explicitHeader:     force the header text (when auto-detection is fooled)
//   name:               the curated name used in the specialized DB
//   year:               the year (or first year) the file covers; used for
//                       year-based filtering. null = unknown / mixed.

export type SourceSpec = {
  file: string;          // basename of the CSV in newIntegrationCSVs/
  category: string;      // "serviz_belso" | "szev_igeny" | "telephely_munka" | "telephely_ais_motor" | "nem_javitjuk" | "statisztika"
  year?: number;         // primary year this file covers
  years?: number[];      // alternative: list of years (used for statisztika)
  rawTable: string;      // table name in cmms.db (prefixed with _v_)
  skipRows?: number;
  explicitHeader?: string[];
};

export const SOURCES: SourceSpec[] = [
  // szerviz_belso (3 files, different schemas — we keep them separate
  // raw tables but normalize into one specialized table)
  { file: "Szervizlap belső - SZERVIZLAP BELSŐ 2008-2020.csv",     category: "serviz_belso", year: 2008, rawTable: "_v_serviz_2008_2020" },
  { file: "Szervizlap belső - SZERVIZLAP BELSŐ 2020- TAKSONY.csv", category: "serviz_belso", year: 2020, rawTable: "_v_serviz_2020_taksony" },
  { file: "Szervizlap belső - SZERVIZLAP BELSŐ 2020-.csv",         category: "serviz_belso", year: 2020, rawTable: "_v_serviz_2020" },

  // szev_igeny (8 yearly files)
  { file: "SZÉV IGÉNY - 2019.csv", category: "szev_igeny", year: 2019, rawTable: "_v_szev_2019" },
  { file: "SZÉV IGÉNY - 2020.csv", category: "szev_igeny", year: 2020, rawTable: "_v_szev_2020" },
  { file: "SZÉV IGÉNY - 2021.csv", category: "szev_igeny", year: 2021, rawTable: "_v_szev_2021" },
  { file: "SZÉV IGÉNY - 2022.csv", category: "szev_igeny", year: 2022, rawTable: "_v_szev_2022" },
  { file: "SZÉV IGÉNY - 2023.csv", category: "szev_igeny", year: 2023, rawTable: "_v_szev_2023" },
  { file: "SZÉV IGÉNY - 2024.csv", category: "szev_igeny", year: 2024, rawTable: "_v_szev_2024" },
  { file: "SZÉV IGÉNY - 2025.csv", category: "szev_igeny", year: 2025, rawTable: "_v_szev_2025" },
  { file: "SZÉV IGÉNY - 2026.csv", category: "szev_igeny", year: 2026, rawTable: "_v_szev_2026" },

  // telephely_munka (3 yearly + 1 multi-year + 1 single-template)
  { file: "Telephelyi munkák - 2018.csv",                     category: "telephely_munka", year: 2018, rawTable: "_v_telephely_2018" },
  { file: "Telephelyi munkák - 2019.csv",                     category: "telephely_munka", year: 2019, rawTable: "_v_telephely_2019" },
  { file: "Telephelyi munkák - 2020.csv",                     category: "telephely_munka", year: 2020, rawTable: "_v_telephely_2020" },
  { file: "Telephelyi munkák - TH javítások adat .csv",       category: "telephely_munka", year: 2020, rawTable: "_v_telephely_th" },
  { file: "Telephelyi munkák - TH munkalap.csv",              category: "telephely_munka", year: 2026, rawTable: "_v_telephely_th_munkalap",
    explicitHeader: ["sorszam", "col", "col_2", "megrendelo", "munkaszam", "geptipus", "beerkezes", "ki_hozta_be",
                     "kiszallitas", "gepepitoelem_megnevezes", "gepepitoelem_tipus", "gepepitoelem_sorozatszam",
                     "hibajelenseg", "mechanikus_munka", "elektromos_munka", "mechanikus_anyagok",
                     "elektromos_anyagok", "dolgozo_k", "telephelyi_munkaora", "gepeszeti",
                     "kulsos_megbizas", "tartozekok_megjegyzes"] },

  // telephely_ais_motor (1)
  { file: "Telephelyi munkák - AiS100.csv", category: "telephely_ais_motor", rawTable: "_v_ais_motor",
    skipRows: 2,  // skip title line + header line (header provided explicitly)
    explicitHeader: ["sorszam", "tipus", "gyari_szam", "melyik_gepeken_volt", "problema",
                     "tartozekok", "megjegyzes", "feladat", "feladat2_dia"] },

  // nem_javitjuk (1, tiny)
  { file: "Szervizlap belső - Nem javítjuk.csv", category: "nem_javitjuk", year: 2026, rawTable: "_v_nem_javitjuk" },

  // statisztika (1)
  // File starts with a year row, then a sub-header row, then data.
  // We pass explicitHeader so the parser doesn't get confused.
  { file: "Szervizlap belső - VS MEO 2.statisztika.csv", category: "statisztika", years: [2022], rawTable: "_v_statisztika",
    skipRows: 1,
    explicitHeader: ["kategoria", "hibas_db", "osszes_gyartott_db", "szazalek", "gar_db", "fiz_db"] },
];

// --- Schema for the specialized DB ------------------------------------------

const SPEC_SCHEMA = `
CREATE TABLE IF NOT EXISTS serviz_belso (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  j_szam TEXT NOT NULL,
  datum_iso TEXT,
  datum_raw TEXT,
  cegnev TEXT,
  cegnev_ascii TEXT,
  cim TEXT,
  ugyfel_nev TEXT,
  munkaszam TEXT,
  eszkoz TEXT,
  eszkoz_ascii TEXT,
  gyariszam TEXT,
  hibajelenseg TEXT,
  hibajelenseg_ascii TEXT,
  elkeszules TEXT,
  nyitott INTEGER,
  munkaora REAL,
  dolgozo TEXT,
  vegzett_munka TEXT,
  vegzett_munka_ascii TEXT,
  felhasznalt_anyag TEXT,
  javitas_helye TEXT,
  megjegyzes TEXT,
  egyeb_info TEXT,
  source_file TEXT,
  source_period TEXT
);
-- Note: source files contain duplicate j_szam values. We do not
-- enforce uniqueness; multiple rows for the same sorszam may exist
-- across the dataset (e.g. J00001 in 2008-2020 and a different J00001
-- in 2020-). The MCP search tool will return all matches.
CREATE INDEX IF NOT EXISTS idx_serviz_j_szam ON serviz_belso(j_szam);
CREATE INDEX IF NOT EXISTS idx_serviz_datum_iso ON serviz_belso(datum_iso);
CREATE INDEX IF NOT EXISTS idx_serviz_ceg_ascii ON serviz_belso(cegnev_ascii);
CREATE INDEX IF NOT EXISTS idx_serviz_eszkoz_ascii ON serviz_belso(eszkoz_ascii);
CREATE INDEX IF NOT EXISTS idx_serviz_hiba_ascii ON serviz_belso(hibajelenseg_ascii);
CREATE INDEX IF NOT EXISTS idx_serviz_munka_ascii ON serviz_belso(vegzett_munka_ascii);
CREATE INDEX IF NOT EXISTS idx_serviz_dolgozo ON serviz_belso(dolgozo);
CREATE INDEX IF NOT EXISTS idx_serviz_source ON serviz_belso(source_period);

CREATE VIRTUAL TABLE IF NOT EXISTS serviz_belso_fts USING fts5(
  j_szam, cegnev, eszkoz, gyariszam, hibajelenseg, vegzett_munka, megjegyzes, dolgozo,
  content='', tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS szev_igeny (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  szev_szam TEXT NOT NULL,
  statusz INTEGER,
  felelos TEXT,
  igeny_datum_iso TEXT,
  teljesites_datum_iso TEXT,
  gepallas TEXT,
  attarolas_betarolas TEXT,
  munkaszam TEXT,
  megrendelo TEXT,
  megrendelo_ascii TEXT,
  geptipus TEXT,
  beszallito TEXT,
  igeny TEXT,
  igeny_ascii TEXT,
  megjegyzes TEXT,
  mennyiseg TEXT,
  igenylo TEXT,
  year INTEGER,
  source_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_szev_szam ON szev_igeny(szev_szam);
CREATE INDEX IF NOT EXISTS idx_szev_year ON szev_igeny(year);
CREATE INDEX IF NOT EXISTS idx_szev_megrendelo_ascii ON szev_igeny(megrendelo_ascii);
CREATE INDEX IF NOT EXISTS idx_szev_igeny_ascii ON szev_igeny(igeny_ascii);
CREATE INDEX IF NOT EXISTS idx_szev_munkaszam ON szev_igeny(munkaszam);

CREATE VIRTUAL TABLE IF NOT EXISTS szev_igeny_fts USING fts5(
  szev_szam, megrendelo, geptipus, munkaszam, igeny, megjegyzes, felelos,
  content='', tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS telephely_munka (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sorszam TEXT,
  munkaszam TEXT,
  beerkezes_iso TEXT,
  kikuldes_iso TEXT,
  megrendelo TEXT,
  megrendelo_ascii TEXT,
  geptipus TEXT,
  geptipus_ascii TEXT,
  gepepitoelem TEXT,
  hibajelenseg TEXT,
  hibajelenseg_ascii TEXT,
  elvegzett_munka TEXT,
  elvegzett_munka_ascii TEXT,
  mechanikus_anyagok TEXT,
  elektromos_anyagok TEXT,
  dolgozo TEXT,
  telephelyi_munkaora TEXT,
  kesz INTEGER,
  year INTEGER,
  source_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_telephely_munkaszam ON telephely_munka(munkaszam);
CREATE INDEX IF NOT EXISTS idx_telephely_year ON telephely_munka(year);
CREATE INDEX IF NOT EXISTS idx_telephely_megrendelo_ascii ON telephely_munka(megrendelo_ascii);
CREATE INDEX IF NOT EXISTS idx_telephely_geptipus_ascii ON telephely_munka(geptipus_ascii);
CREATE INDEX IF NOT EXISTS idx_telephely_hiba_ascii ON telephely_munka(hibajelenseg_ascii);
CREATE INDEX IF NOT EXISTS idx_telephely_munka_ascii ON telephely_munka(elvegzett_munka_ascii);

CREATE VIRTUAL TABLE IF NOT EXISTS telephely_munka_fts USING fts5(
  munkaszam, megrendelo, geptipus, gepepitoelem, hibajelenseg, elvegzett_munka, mechanikus_anyagok, elektromos_anyagok, dolgozo,
  content='', tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS telephely_ais_motor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sorszam TEXT,
  tipus TEXT,
  gyari_szam TEXT,
  melyik_gepeken_volt TEXT,
  melyik_gepeken_volt_ascii TEXT,
  problema TEXT,
  problema_ascii TEXT,
  tartozekok TEXT,
  megjegyzes TEXT,
  feladat TEXT,
  feladat2_dia TEXT,
  source_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_ais_tipus ON telephely_ais_motor(tipus);
CREATE INDEX IF NOT EXISTS idx_ais_gep_ascii ON telephely_ais_motor(melyik_gepeken_volt_ascii);
CREATE INDEX IF NOT EXISTS idx_ais_problema_ascii ON telephely_ais_motor(problema_ascii);

CREATE VIRTUAL TABLE IF NOT EXISTS telephely_ais_motor_fts USING fts5(
  tipus, gyari_szam, melyik_gepeken_volt, problema, tartozekok, megjegyzes, feladat,
  content='', tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS nem_javitjuk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datum_iso TEXT,
  cegnev TEXT,
  cim TEXT,
  ugyfel_nev TEXT,
  m_szam TEXT,
  eszkoz TEXT,
  eszkoz_ascii TEXT,
  megjegyzes TEXT,
  source_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_nemjavit_datum ON nem_javitjuk(datum_iso);
CREATE INDEX IF NOT EXISTS idx_nemjavit_eszkoz_ascii ON nem_javitjuk(eszkoz_ascii);

CREATE TABLE IF NOT EXISTS statisztika (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ev INTEGER NOT NULL,
  kategoria TEXT NOT NULL,
  kategoria_ascii TEXT,
  hibas_db INTEGER,
  ossz_gyartott_db INTEGER,
  szazalek REAL,
  gar_db INTEGER,
  fiz_db INTEGER,
  source_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_stat_ev ON statisztika(ev);
CREATE INDEX IF NOT EXISTS idx_stat_kategoria_ascii ON statisztika(kategoria_ascii);

CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// --- Column mapping per source category -------------------------------------

type ColMap = Record<string, string | null>;
// Each entry: target_specialized_col -> source_csv_col_alias
// (alias = one of the CSV's column names, looked up in CsvRow by index)

const SERVIZ_BELSO_COLS: ColMap = {
  j_szam:             "j_szam",
  datum_raw:          "datum",
  cegnev:             "cegnev",
  cim:                "cim",
  ugyfel_nev:         "ugyfel_neve",
  munkaszam:          "munkaszam",
  eszkoz:             "eszkoz",
  gyariszam:          "gyariszam",
  hibajelenseg:       "hibajelenseg",
  elkeszules:         "elkeszules",
  nyitott:            "nyitott_1_lezart_0",
  munkaora:           "munkaora",
  dolgozo:            "dolgozo",
  vegzett_munka:      "vegzett_munka",
  felhasznalt_anyag:  "felhasznalt_anyag",
  javitas_helye:      "javitas_helye",
  megjegyzes:         "megjegyzes",
  egyeb_info:         "egyeb_informaciok",
};

const SZEV_IGENY_COLS: ColMap = {
  szev_szam:            "szev_igeny_szam",
  statusz:              "statusz",
  felelos:              "felelos",
  igeny_datum_raw:      "igeny_datuma",
  gepallas:             "gepallas",
  teljesites_datum_raw: "teljesites_datuma",
  attarolas_betarolas:  "attarolas_betarolas_szama",
  munkaszam:            "munkaszam",
  megrendelo:           "megrendelo",
  geptipus:             "geptipus",
  beszallito:           "beszallito",
  igeny:                "igeny",
  megjegyzes:           "megjegyzes",
  mennyiseg:            "mennyiseg",
  igenylo:              "igenylo",
};

const TELEPHELY_MUNKA_COLS: ColMap = {
  sorszam:        "sorszam",
  munkaszam:      "munkaszam",
  beerkezes_raw:  "beerkezes_datuma",
  kikuldes_raw:   "kikuldes_datuma",
  megrendelo:     "megrendelo",   // 2018/2019 use "megrendelo"; 2020 uses "ceg_neve" — see fallback below
  geptipus:       "geptipus",
  gepepitoelem:   "megnevezes",   // 2018/2019/2020 use "megnevezes" for the build element
  hibajelenseg:   "bejelentett_hiba",
  elvegzett_munka:"elvegzett_munka_szervizlapra_irando",  // long name in 2018/2019/2020
  mechanikus_anyagok: "beszerzett_alkatreszek",  // 2018/2019/2020 don't split mech/elec
  elektromos_anyagok: null,                       // 2018/2019/2020 lump everything into "beszerzett"
  dolgozo:        "telephelyi_munkaido",  // closest match in 2018/2019/2020
  telephelyi_munkaora: null,
  kesz:           "kesz_1",
};

// TH javítások adat uses a different shape
const TELEPHELY_TH_COLS: ColMap = {
  sorszam:        "sorszam",
  munkaszam:      "munkaszam",
  beerkezes_raw:  "beerkezes",
  kikuldes_raw:   "kiszallitas_elkeszules",
  megrendelo:     "megrendelo",
  geptipus:       "geptipus",
  gepepitoelem:   "gepepitoelem",
  hibajelenseg:   "hibajelenseg",
  elvegzett_munka:"mechanikus_munka",  // close enough; the file has mech + elec split
  mechanikus_anyagok: "mechanikus_anyagok",
  elektromos_anyagok: "elektromos_anyagok",
  dolgozo:        "dolgozo_k",
  telephelyi_munkaora: "telephelyi_munkaora",
  kesz:           "kesz",
};

// TH munkalap has explicit header; reuse the TH shape
const TELEPHELY_TH_MUNKALAP_COLS: ColMap = {
  sorszam:        "sorszam",
  munkaszam:      "munkaszam",
  beerkezes_raw:  "beerkezes",
  kikuldes_raw:   "kiszallitas",
  megrendelo:     "megrendelo",
  geptipus:       "geptipus",
  gepepitoelem:   "gepepitoelem_megnevezes",
  hibajelenseg:   "hibajelenseg",
  elvegzett_munka:"mechanikus_munka",
  mechanikus_anyagok: "mechanikus_anyagok",
  elektromos_anyagok: "elektromos_anyagok",
  dolgozo:        "dolgozo_k",
  telephelyi_munkaora: "telephelyi_munkaora",
  kesz:           null,
};

const AIS_MOTOR_COLS: ColMap = {
  sorszam:              "sorszam",
  tipus:                "tipus",
  gyari_szam:           "gyari_szam",
  melyik_gepeken_volt:  "melyik_gepeken_volt",
  problema:             "problema",
  tartozekok:           "tartozekok",
  megjegyzes:           "megjegyzes",
  feladat:              "feladat",
  feladat2_dia:         "feladat2_dia",
};

const NEM_JAVITJUK_COLS: ColMap = {
  datum_raw:    "datum",
  cegnev:       "cegnev",
  cim:          "cim",
  ugyfel_nev:   "ugyfel_nev",
  m_szam:       "m_szam",
  eszkoz:       "eszkoz",
  megjegyzes:   "megjegyzes",
};

// --- Main entry point -------------------------------------------------------

export type IntegrationResult = {
  files: number;
  totalRows: number;
  byTable: Record<string, number>;
  durationMs: number;
  errors: string[];
};

export function runIntegration(opts: {
  cmmsDbPath: string;
  specDbPath: string;
  csvDir: string;
}): IntegrationResult {
  const t0 = Date.now();
  const cmms = new Database(opts.cmmsDbPath);
  cmms.exec("PRAGMA journal_mode = WAL;");
  cmms.exec("PRAGMA synchronous = NORMAL;");
  cmms.exec("PRAGMA busy_timeout = 5000;");

  const spec = new Database(opts.specDbPath, { create: true });
  spec.exec("PRAGMA journal_mode = WAL;");
  spec.exec("PRAGMA synchronous = NORMAL;");
  spec.exec("PRAGMA busy_timeout = 5000;");
  spec.exec(SPEC_SCHEMA);

  const errors: string[] = [];
  const byTable: Record<string, number> = {};
  let totalRows = 0;

  for (const src of SOURCES) {
    const path = join(opts.csvDir, src.file);
    let stat;
    try {
      stat = statSync(path);
    } catch (e) {
      errors.push(`missing file: ${src.file}`);
      continue;
    }
    const text = readFileSync(path, "utf-8");
    const parsed = parseCsv(text, { skipRows: src.skipRows, explicitHeader: src.explicitHeader });
    const colIndex = new Map<string, number>();
    parsed.header.forEach((h, i) => colIndex.set(h, i));

    // 1) Raw table in cmms.db
    const rawCount = loadRaw(cmms, src, parsed, colIndex);
    byTable[src.rawTable] = (byTable[src.rawTable] ?? 0) + rawCount;

    // 2) Specialized table + FTS
    let specCount = 0;
    try {
      switch (src.category) {
        case "serviz_belso":
          specCount = loadServizBelso(spec, src, parsed, colIndex);
          break;
        case "szev_igeny":
          specCount = loadSzevIgeny(spec, src, parsed, colIndex);
          break;
        case "telephely_munka":
          specCount = loadTelephelyMunka(spec, src, parsed, colIndex);
          break;
        case "telephely_ais_motor":
          specCount = loadAisMotor(spec, src, parsed, colIndex);
          break;
        case "nem_javitjuk":
          specCount = loadNemJavitjuk(spec, src, parsed, colIndex);
          break;
        case "statisztika":
          specCount = loadStatisztika(spec, src, parsed, colIndex);
          break;
      }
    } catch (e) {
      errors.push(`${src.file}: ${(e as Error).message}`);
    }
    byTable[categoryTable(src.category)] = (byTable[categoryTable(src.category)] ?? 0) + specCount;
    totalRows += rawCount + specCount;
    console.log(`loaded ${src.file}  (${stat.size} B, ${parsed.rows.length} raw rows → ${rawCount} raw + ${specCount} spec)`);
  }

  // Rebuild FTS contents from the data tables (content='' tables need explicit population).
  rebuildFts(spec);

  // meta
  const insertMeta = spec.prepare(`INSERT INTO _meta (key, value) VALUES (?, ?)
                                   ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  insertMeta.run("integration_built_at", new Date().toISOString());
  insertMeta.run("integration_source_dir", opts.csvDir);
  insertMeta.run("integration_files_loaded", String(SOURCES.length));
  insertMeta.run("integration_total_rows", String(totalRows));

  // Also a small meta in cmms.db
  const cmmsMeta = cmms.prepare(`CREATE TABLE IF NOT EXISTS _integration_meta (key TEXT PRIMARY KEY, value TEXT)`);
  cmmsMeta.run();
  const ins = cmms.prepare(`INSERT INTO _integration_meta (key, value) VALUES (?, ?)
                            ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  ins.run("integration_built_at", new Date().toISOString());
  ins.run("integration_source_dir", opts.csvDir);

  cmms.close();
  spec.close();

  return {
    files: SOURCES.length,
    totalRows,
    byTable,
    durationMs: Date.now() - t0,
    errors,
  };
}

function categoryTable(c: string): string {
  switch (c) {
    case "serviz_belso": return "serviz_belso";
    case "szev_igeny": return "szev_igeny";
    case "telephely_munka": return "telephely_munka";
    case "telephely_ais_motor": return "telephely_ais_motor";
    case "nem_javitjuk": return "nem_javitjuk";
    case "statisztika": return "statisztika";
    default: return c;
  }
}

// --- Raw loader -------------------------------------------------------------

function loadRaw(
  cmms: Database,
  src: SourceSpec,
  parsed: { header: string[]; rows: CsvRow[] },
  colIndex: Map<string, number>,
): number {
  // Drop + recreate the raw table.
  cmms.exec(`DROP TABLE IF EXISTS "${src.rawTable}"`);
  const cols = parsed.header.map((h) => `"${h}" TEXT`).join(", ");
  cmms.exec(`CREATE TABLE "${src.rawTable}" (rowid INTEGER PRIMARY KEY AUTOINCREMENT, _source_file TEXT, ${cols})`);
  const insert = cmms.prepare(
    `INSERT INTO "${src.rawTable}" (_source_file, ${parsed.header.map((h) => `"${h}"`).join(", ")})
     VALUES (${new Array(parsed.header.length + 1).fill("?").join(", ")})`,
  );
  const tx = cmms.transaction((rows: CsvRow[]) => {
    for (const r of rows) {
      insert.run(src.file, ...r);
    }
  });
  tx(parsed.rows);
  return parsed.rows.length;
}

// --- Specialized loaders ---------------------------------------------------

// Try multiple CSV column names in order, return the first non-empty value.
function pickMulti(row: CsvRow, colIndex: Map<string, number>, csvCols: (string | null | undefined)[]): string | null {
  for (const c of csvCols) {
    if (c == null) continue;
    const i = colIndex.get(c);
    if (i == null) continue;
    const v = row[i];
    if (v == null) continue;
    const s = String(v).trim();
    if (s !== "") return s;
  }
  return null;
}

// Single-column lookup (returns the trimmed value or null).
function pick(row: CsvRow, colIndex: Map<string, number>, csvCol: string | null): string | null {
  if (csvCol == null) return null;
  const i = colIndex.get(csvCol);
  if (i == null) return null;
  const v = row[i];
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function loadServizBelso(
  spec: Database,
  src: SourceSpec,
  parsed: { header: string[]; rows: CsvRow[] },
  colIndex: Map<string, number>,
): number {
  const cols = SERVIZ_BELSO_COLS;
  // Idempotent: delete rows for this source_period so re-runs are clean.
  spec.prepare(`DELETE FROM serviz_belso WHERE source_period = ?`).run(src.file);
  const ins = spec.prepare(
    `INSERT INTO serviz_belso (
       j_szam, datum_iso, datum_raw, cegnev, cegnev_ascii, cim, ugyfel_nev, munkaszam,
       eszkoz, eszkoz_ascii, gyariszam, hibajelenseg, hibajelenseg_ascii, elkeszules,
       nyitott, munkaora, dolgozo, vegzett_munka, vegzett_munka_ascii, felhasznalt_anyag,
       javitas_helye, megjegyzes, egyeb_info, source_file, source_period
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const period = src.file; // raw file name; gives us 2008-2020 / 2020-taksony / 2020-
  let n = 0;
  const tx = spec.transaction((rows: CsvRow[]) => {
    for (const r of rows) {
      const j = pick(r, colIndex, cols.j_szam);
      if (!j) continue;
      const cegnev = pick(r, colIndex, cols.cegnev);
      const eszkoz = pick(r, colIndex, cols.eszkoz);
      const hiba = pick(r, colIndex, cols.hibajelenseg);
      const munka = pick(r, colIndex, cols.vegzett_munka);
      const datumRaw = pick(r, colIndex, cols.datum_raw);
      ins.run(
        j,
        normalizeDate(datumRaw),
        datumRaw,
        cegnev,
        fold(cegnev),
        pick(r, colIndex, cols.cim),
        pick(r, colIndex, cols.ugyfel_nev),
        pick(r, colIndex, cols.munkaszam),
        eszkoz,
        fold(eszkoz),
        pick(r, colIndex, cols.gyariszam),
        hiba,
        fold(hiba),
        pick(r, colIndex, cols.elkeszules),
        normalizeBool(pick(r, colIndex, cols.nyitott)),
        normalizeNumber(pick(r, colIndex, cols.munkaora)),
        pick(r, colIndex, cols.dolgozo),
        munka,
        fold(munka),
        pick(r, colIndex, cols.felhasznalt_anyag),
        pick(r, colIndex, cols.javitas_helye),
        pick(r, colIndex, cols.megjegyzes),
        pick(r, colIndex, cols.egyeb_info),
        src.file,
        period,
      );
      n++;
    }
  });
  tx(parsed.rows);
  return n;
}

function loadSzevIgeny(
  spec: Database,
  src: SourceSpec,
  parsed: { header: string[]; rows: CsvRow[] },
  colIndex: Map<string, number>,
): number {
  const cols = SZEV_IGENY_COLS;
  spec.prepare(`DELETE FROM szev_igeny WHERE source_file = ?`).run(src.file);
  const ins = spec.prepare(
    `INSERT INTO szev_igeny (
       szev_szam, statusz, felelos, igeny_datum_iso, gepallas, teljesites_datum_iso,
       attarolas_betarolas, munkaszam, megrendelo, megrendelo_ascii, geptipus, beszallito,
       igeny, igeny_ascii, megjegyzes, mennyiseg, igenylo, year, source_file
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  const tx = spec.transaction((rows: CsvRow[]) => {
    for (const r of rows) {
      // Three different header names for the ticket number across years.
      const szam = pickMulti(r, colIndex, [cols.szev_szam, "iktatoszam", "igenyszam"]);
      if (!szam) continue;
      // munkaszam may be "munkaszam" (2022+) or "msz" (2019/2020/2021)
      const munkaszam = pickMulti(r, colIndex, [cols.munkaszam, "msz"]);
      // megjegyzes has two variants in the older files: "megjegyzes_email" and "megjegyzes_gye"
      const megjegyzes = pickMulti(r, colIndex, [
        cols.megjegyzes,
        "megjegyzes_email",
        "megjegyzes_gye",
      ]);
      const igenyDatum = pick(r, colIndex, cols.igeny_datum_raw);
      const teljesitesDatum = pick(r, colIndex, cols.teljesites_datum_raw);
      const megrendelo = pick(r, colIndex, cols.megrendelo);
      const igeny = pick(r, colIndex, cols.igeny);
      ins.run(
        szam,
        normalizeBool(pick(r, colIndex, cols.statusz)),
        pick(r, colIndex, cols.felelos),
        normalizeDate(igenyDatum),
        pick(r, colIndex, cols.gepallas),
        normalizeDate(teljesitesDatum),
        pick(r, colIndex, cols.attarolas_betarolas),
        munkaszam,
        megrendelo,
        fold(megrendelo),
        pick(r, colIndex, cols.geptipus),
        pick(r, colIndex, cols.beszallito),
        igeny,
        fold(igeny),
        megjegyzes,
        pick(r, colIndex, cols.mennyiseg),
        pick(r, colIndex, cols.igenylo),
        src.year ?? null,
        src.file,
      );
      n++;
    }
  });
  tx(parsed.rows);
  return n;
}

function loadTelephelyMunka(
  spec: Database,
  src: SourceSpec,
  parsed: { header: string[]; rows: CsvRow[] },
  colIndex: Map<string, number>,
): number {
  // Per-shape column maps
  const cols = src.rawTable === "_v_telephely_th"
    ? TELEPHELY_TH_COLS
    : src.rawTable === "_v_telephely_th_munkalap"
      ? TELEPHELY_TH_MUNKALAP_COLS
      : TELEPHELY_MUNKA_COLS;

  spec.prepare(`DELETE FROM telephely_munka WHERE source_file = ?`).run(src.file);
  const ins = spec.prepare(
    `INSERT INTO telephely_munka (
       sorszam, munkaszam, beerkezes_iso, kikuldes_iso, megrendelo, megrendelo_ascii,
       geptipus, geptipus_ascii, gepepitoelem, hibajelenseg, hibajelenseg_ascii,
       elvegzett_munka, elvegzett_munka_ascii, mechanikus_anyagok, elektromos_anyagok,
       dolgozo, telephelyi_munkaora, kesz, year, source_file
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  const tx = spec.transaction((rows: CsvRow[]) => {
    for (const r of rows) {
      // Accept any row that has a munkaszam, sorszam, OR a non-empty
      // hibajelenseg (some yearly files have no munkaszam column at all,
      // e.g. 2018 — they only carry dates + customer + fault).
      const so = pick(r, colIndex, cols.sorszam);
      const mk = pick(r, colIndex, cols.munkaszam);
      const hb = pick(r, colIndex, cols.hibajelenseg);
      if (!so && !mk && !hb) continue;
      // megrendelo: 2018/2019/2020 yearly files use "megrendelo" (2018/2019) or
      // "ceg_neve" (2020). TH files use "megrendelo". Try the primary column
      // then fall back to known alternates.
      const megrendelo = pickMulti(r, colIndex, [cols.megrendelo, "ceg_neve", "cegnev"]);
      const geptipus = pick(r, colIndex, cols.geptipus);
      const hiba = hb;
      const munka = pick(r, colIndex, cols.elvegzett_munka);
      const beerkezes = pick(r, colIndex, cols.beerkezes_raw);
      const kikuldes = pick(r, colIndex, cols.kikuldes_raw);
      const keszRaw = pick(r, colIndex, cols.kesz);
      ins.run(
        so,
        mk,
        normalizeDate(beerkezes),
        normalizeDate(kikuldes),
        megrendelo,
        fold(megrendelo),
        geptipus,
        fold(geptipus),
        pick(r, colIndex, cols.gepepitoelem),
        hiba,
        fold(hiba),
        munka,
        fold(munka),
        pick(r, colIndex, cols.mechanikus_anyagok),
        pick(r, colIndex, cols.elektromos_anyagok),
        pick(r, colIndex, cols.dolgozo),
        pick(r, colIndex, cols.telephelyi_munkaora),
        normalizeBool(keszRaw) ?? normalizeNumber(keszRaw),
        src.year ?? null,
        src.file,
      );
      n++;
    }
  });
  tx(parsed.rows);
  return n;
}

function loadAisMotor(
  spec: Database,
  src: SourceSpec,
  parsed: { header: string[]; rows: CsvRow[] },
  colIndex: Map<string, number>,
): number {
  const cols = AIS_MOTOR_COLS;
  spec.prepare(`DELETE FROM telephely_ais_motor WHERE source_file = ?`).run(src.file);
  const ins = spec.prepare(
    `INSERT INTO telephely_ais_motor (
       sorszam, tipus, gyari_szam, melyik_gepeken_volt, melyik_gepeken_volt_ascii,
       problema, problema_ascii, tartozekok, megjegyzes, feladat, feladat2_dia, source_file
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  const tx = spec.transaction((rows: CsvRow[]) => {
    for (const r of rows) {
      const so = pick(r, colIndex, cols.sorszam);
      const tipus = pick(r, colIndex, cols.tipus);
      // Drop the title/header/section-header rows that some inventory
      // files contain. Real rows have a short numeric sorszam.
      if (!so) continue;
      const soLow = so.toLowerCase();
      if (
        soLow === "sorszam" ||
        soLow === "sor" ||
        soLow.startsWith("a csarnokban") ||
        so.length > 30
      ) continue;
      if (tipus && (tipus.toLowerCase().startsWith("tipus") || tipus.toLowerCase() === "típus")) continue;
      const gep = pick(r, colIndex, cols.melyik_gepeken_volt);
      const problema = pick(r, colIndex, cols.problema);
      ins.run(
        so,
        tipus,
        pick(r, colIndex, cols.gyari_szam),
        gep,
        gep ? fold(gep) : null,
        problema,
        problema ? fold(problema) : null,
        pick(r, colIndex, cols.tartozekok),
        pick(r, colIndex, cols.megjegyzes),
        pick(r, colIndex, cols.feladat),
        pick(r, colIndex, cols.feladat2_dia),
        src.file,
      );
      n++;
    }
  });
  tx(parsed.rows);
  return n;
}

function loadNemJavitjuk(
  spec: Database,
  src: SourceSpec,
  parsed: { header: string[]; rows: CsvRow[] },
  colIndex: Map<string, number>,
): number {
  const cols = NEM_JAVITJUK_COLS;
  spec.prepare(`DELETE FROM nem_javitjuk WHERE source_file = ?`).run(src.file);
  const ins = spec.prepare(
    `INSERT INTO nem_javitjuk (
       datum_iso, cegnev, cim, ugyfel_nev, m_szam, eszkoz, eszkoz_ascii, megjegyzes, source_file
     ) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  const tx = spec.transaction((rows: CsvRow[]) => {
    for (const r of rows) {
      const datum = pick(r, colIndex, cols.datum_raw);
      const eszk = pick(r, colIndex, cols.eszkoz);
      ins.run(
        normalizeDate(datum),
        pick(r, colIndex, cols.cegnev),
        pick(r, colIndex, cols.cim),
        pick(r, colIndex, cols.ugyfel_nev),
        pick(r, colIndex, cols.m_szam),
        eszk,
        eszk ? fold(eszk) : null,
        pick(r, colIndex, cols.megjegyzes),
        src.file,
      );
      n++;
    }
  });
  tx(parsed.rows);
  return n;
}

function loadStatisztika(
  spec: Database,
  src: SourceSpec,
  parsed: { header: string[]; rows: CsvRow[] },
  colIndex: Map<string, number>,
): number {
  // The statisztika file's structure is unique: first column is the
  // category name (e.g. "DxC hajtások"), then the numeric columns.
  // We extract category from col 0 and year from src.years[0].
  spec.prepare(`DELETE FROM statisztika WHERE source_file = ?`).run(src.file);
  const ins = spec.prepare(
    `INSERT INTO statisztika (ev, kategoria, kategoria_ascii, hibas_db, ossz_gyartott_db, szazalek, gar_db, fiz_db, source_file)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const year = src.years?.[0] ?? null;
  let n = 0;
  // Detect numeric column index by header name in colIndex
  const hibIdx = colIndex.get("hibas_db") ?? colIndex.get("hibas_db_2");
  const osszIdx = colIndex.get("ossz_gyartott_db") ?? colIndex.get("osszes_gyartott_db") ?? colIndex.get("ossz_gyartott_db_2");
  const szazIdx = colIndex.get("szazalek") ?? colIndex.get("szazalek_2") ?? colIndex.get("%");
  const garIdx = colIndex.get("gar_db") ?? colIndex.get("gar_db_2");
  const fizIdx = colIndex.get("fiz_db") ?? colIndex.get("fiz_db_2");
  const tx = spec.transaction((rows: CsvRow[]) => {
    for (const r of rows) {
      const kat = r[0];
      if (kat == null) continue;
      const k = String(kat).trim();
      if (k === "") continue;
      // Drop header artifacts: a 4-digit year alone (e.g. "2022") and
      // the section header "kategória". The file has two concatenated
      // tables; both are valid data and we ingest rows from each.
      if (/^\d{4}$/.test(k)) continue;
      if (k.toLowerCase() === "kategória" || k.toLowerCase() === "kategoria") continue;
      ins.run(
        year,
        k,
        fold(k),
        hibIdx != null ? normalizeNumber(r[hibIdx]) : null,
        osszIdx != null ? normalizeNumber(r[osszIdx]) : null,
        szazIdx != null ? normalizeNumber(r[szazIdx]) : null,
        garIdx != null ? normalizeNumber(r[garIdx]) : null,
        fizIdx != null ? normalizeNumber(r[fizIdx]) : null,
        src.file,
      );
      n++;
    }
  });
  tx(parsed.rows);
  return n;
}

// --- FTS population ---------------------------------------------------------
//
// We use content='' external-content FTS5 tables, so we need to push
// rows in explicitly. Triggers would be a fancier approach, but a one-shot
// rebuild after the bulk load is simpler and fast enough for this dataset.

function rebuildFts(spec: Database) {
  // FTS5 contentless tables (content='') cannot be DELETE'd. We DROP
  // and recreate them, then INSERT the rows back in.
  spec.exec("DROP TABLE IF EXISTS serviz_belso_fts");
  spec.exec("DROP TABLE IF EXISTS szev_igeny_fts");
  spec.exec("DROP TABLE IF EXISTS telephely_munka_fts");
  spec.exec("DROP TABLE IF EXISTS telephely_ais_motor_fts");

  spec.exec(`CREATE VIRTUAL TABLE serviz_belso_fts USING fts5(
    j_szam, cegnev, eszkoz, gyariszam, hibajelenseg, vegzett_munka, megjegyzes, dolgozo,
    content='', tokenize = 'unicode61 remove_diacritics 2'
  )`);
  spec.exec(`CREATE VIRTUAL TABLE szev_igeny_fts USING fts5(
    szev_szam, megrendelo, geptipus, munkaszam, igeny, megjegyzes, felelos,
    content='', tokenize = 'unicode61 remove_diacritics 2'
  )`);
  spec.exec(`CREATE VIRTUAL TABLE telephely_munka_fts USING fts5(
    munkaszam, megrendelo, geptipus, gepepitoelem, hibajelenseg, elvegzett_munka, mechanikus_anyagok, elektromos_anyagok, dolgozo,
    content='', tokenize = 'unicode61 remove_diacritics 2'
  )`);
  spec.exec(`CREATE VIRTUAL TABLE telephely_ais_motor_fts USING fts5(
    tipus, gyari_szam, melyik_gepeken_volt, problema, tartozekok, megjegyzes, feladat,
    content='', tokenize = 'unicode61 remove_diacritics 2'
  )`);

  spec.exec(`INSERT INTO serviz_belso_fts (rowid, j_szam, cegnev, eszkoz, gyariszam, hibajelenseg, vegzett_munka, megjegyzes, dolgozo)
             SELECT id, COALESCE(j_szam,''), COALESCE(cegnev,''), COALESCE(eszkoz,''), COALESCE(gyariszam,''),
                    COALESCE(hibajelenseg,''), COALESCE(vegzett_munka,''), COALESCE(megjegyzes,''), COALESCE(dolgozo,'')
             FROM serviz_belso`);

  spec.exec(`INSERT INTO szev_igeny_fts (rowid, szev_szam, megrendelo, geptipus, munkaszam, igeny, megjegyzes, felelos)
             SELECT id, COALESCE(szev_szam,''), COALESCE(megrendelo,''), COALESCE(geptipus,''), COALESCE(munkaszam,''),
                    COALESCE(igeny,''), COALESCE(megjegyzes,''), COALESCE(felelos,'')
             FROM szev_igeny`);

  spec.exec(`INSERT INTO telephely_munka_fts (rowid, munkaszam, megrendelo, geptipus, gepepitoelem, hibajelenseg, elvegzett_munka, mechanikus_anyagok, elektromos_anyagok, dolgozo)
             SELECT id, COALESCE(munkaszam,''), COALESCE(megrendelo,''), COALESCE(geptipus,''), COALESCE(gepepitoelem,''),
                    COALESCE(hibajelenseg,''), COALESCE(elvegzett_munka,''), COALESCE(mechanikus_anyagok,''),
                    COALESCE(elektromos_anyagok,''), COALESCE(dolgozo,'')
             FROM telephely_munka`);

  spec.exec(`INSERT INTO telephely_ais_motor_fts (rowid, tipus, gyari_szam, melyik_gepeken_volt, problema, tartozekok, megjegyzes, feladat)
             SELECT id, COALESCE(tipus,''), COALESCE(gyari_szam,''), COALESCE(melyik_gepeken_volt,''),
                    COALESCE(problema,''), COALESCE(tartozekok,''), COALESCE(megjegyzes,''), COALESCE(feladat,'')
             FROM telephely_ais_motor`);
}
