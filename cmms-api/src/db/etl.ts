// ETL: read cmms.db `data` table -> populate cmms_specialized.db.
//
//   full():    drop + repopulate customers, devices, jobs, notes. Used on
//              first start or when the mtime check decides a rebuild is needed.
//   incremental(): only adds rows whose KEY is greater than the current
//              max(key) in jobs. Safe when the human CMMS app appends new
//              rows. If the mtime advanced without KEY growth (someone edited
//              historical rows), we log a warning; we do not re-extract
//              history to avoid clobbering human changes.
import { statSync } from "node:fs";
import type { OpenDbs } from "./open";
import { fold, parseDateDot, parseDeviceCell, tokenize } from "./parse";

const META_MTIME = "last_mtime";
const META_ROWCOUNT = "rowcount";
const META_LAST_KEY = "last_key";

const BATCH = 1000;

type Row = Record<string, any>;

export type EtlResult = {
  rows: number;
  devices: number;
  notes: number;
  durationMs: number;
  full: boolean;
};

export function getMtimeMs(cmms: { query: (sql: string) => any }): number {
  const r = cmms
    .query(`SELECT (SELECT mtime FROM file_meta WHERE name IS NULL) AS m`)
    .get();
  // Fallback: read file stat if file_meta is empty.
  return 0;
}

export function maybeRunEtl(dbs: OpenDbs, opts?: { forceFull?: boolean }): EtlResult {
  const mtime = statMtime(dbs.cmmsPath);
  const last = (dbs.stmts.getMeta.get(META_MTIME) as { value: string } | undefined)?.value;
  const lastN = last ? Number(last) : 0;

  if (opts?.forceFull || !last || mtime > lastN) {
    return runFullEtl(dbs, mtime);
  }
  return runIncrementalEtl(dbs);
}

export function runFullEtl(dbs: OpenDbs, mtimeMs?: number): EtlResult {
  const t0 = Date.now();
  // Truncate first.
  dbs.stmts.clearAll();

  const count = countRows(dbs.cmms);
  const total = count?.n ?? 0;
  let processed = 0;
  let devices = 0;
  let notes = 0;

  // Stream rows in batches. We select all columns explicitly and alias
  // the date column (whose name is the literal string "1") so that
  // bun:sqlite gives us a usable property name in the result row.
  const stmt = dbs.cmms.prepare(
    `SELECT "KEY", "BEJELENTÉS SORSZÁMA", "1" AS reported_at, "AKTUÁLIS NÉV",
            "RÉGI NÉV", "IRSZ.", "CÍM", "TELEFON", "E-MAIL", "BEJELENTŐ",
            "HIBAFELVEVŐ", "KÉSZÜLÉK TIPUSA", "BEJELENTETT HIBA",
            "ELVÉGZETT MUNKA", "FIZ/GAR", "ÜH. GARANCIA", "NY/Z", "TERV",
            "TÁVOLIGÉPELÉRÉS", "ELKÉSZÜLÉS", "DOLGOZÓ", "MEGJEGYZÉS"
     FROM data ORDER BY "KEY" ASC`,
  );
  let buf: Row[] = [];
  const insertBatch = dbs.spec.transaction((rows: Row[]) => {
    for (const r of rows) {
      const wrote = insertOne(dbs, r);
      devices += wrote.devices;
      notes += wrote.notes;
    }
  });

  for (const r of stmt.iterate() as Iterable<Row>) {
    buf.push(r);
    if (buf.length >= BATCH) {
      insertBatch(buf);
      processed += buf.length;
      buf = [];
      if (processed % (BATCH * 10) === 0) {
        log("etl", { processed, total });
      }
    }
  }
  if (buf.length) {
    insertBatch(buf);
    processed += buf.length;
    buf = [];
  }

  const mt = mtimeMs ?? statMtime(dbs.cmmsPath);
  dbs.stmts.setMeta.run(META_MTIME, String(mt));
  dbs.stmts.setMeta.run(META_ROWCOUNT, String(processed));
  const maxKey = (dbs.stmts.maxKey.get() as { m: number }).m;
  dbs.stmts.setMeta.run(META_LAST_KEY, String(maxKey));

  return { rows: processed, devices, notes, durationMs: Date.now() - t0, full: true };
}

export function runIncrementalEtl(dbs: OpenDbs): EtlResult {
  const t0 = Date.now();
  const lastKey = Number(
    (dbs.stmts.getMeta.get(META_LAST_KEY) as { value: string } | undefined)?.value ?? "0",
  );

  const stmt = dbs.cmms.prepare(
    `SELECT "KEY", "BEJELENTÉS SORSZÁMA", "1" AS reported_at, "AKTUÁLIS NÉV",
            "RÉGI NÉV", "IRSZ.", "CÍM", "TELEFON", "E-MAIL", "BEJELENTŐ",
            "HIBAFELVEVŐ", "KÉSZÜLÉK TIPUSA", "BEJELENTETT HIBA",
            "ELVÉGZETT MUNKA", "FIZ/GAR", "ÜH. GARANCIA", "NY/Z", "TERV",
            "TÁVOLIGÉPELÉRÉS", "ELKÉSZÜLÉS", "DOLGOZÓ", "MEGJEGYZÉS"
     FROM data WHERE "KEY" > ? ORDER BY "KEY" ASC`,
  );
  let processed = 0;
  let devices = 0;
  let notes = 0;
  let maxSeen = lastKey;

  const buf: Row[] = [];
  const insertBatch = dbs.spec.transaction((rows: Row[]) => {
    for (const r of rows) {
      const wrote = insertOne(dbs, r);
      devices += wrote.devices;
      notes += wrote.notes;
      if (r["KEY"] > maxSeen) maxSeen = r["KEY"];
    }
  });

  for (const r of stmt.iterate(lastKey) as Iterable<Row>) {
    buf.push(r);
    if (buf.length >= BATCH) {
      insertBatch(buf);
      processed += buf.length;
      buf.length = 0;
    }
  }
  if (buf.length) {
    insertBatch(buf);
    processed += buf.length;
    buf.length = 0;
  }

  if (processed > 0) {
    dbs.stmts.setMeta.run(META_MTIME, String(statMtime(dbs.cmmsPath)));
    dbs.stmts.setMeta.run(META_LAST_KEY, String(maxSeen));
  }
  return { rows: processed, devices, notes, durationMs: Date.now() - t0, full: false };
}

function countRows(cmms: { query: (sql: string) => any }): { n: number } | undefined {
  return cmms.query(`SELECT COUNT(*) AS n FROM data`).get() as { n: number };
}

function insertOne(dbs: OpenDbs, r: Row): { devices: number; notes: number } {
  const key = Number(r["KEY"]);
  const reportedAt = r["reported_at"] ?? null;
  let sorszam = String(r["BEJELENTÉS SORSZÁMA"] ?? "").trim();
  // The source sheet has occasional duplicate sorszam values. We keep
  // the first occurrence's sorszam and append a key-suffix to later ones
  // so the specialized DB's UNIQUE constraint holds.
  if (sorszam !== "" && dbs.stmts.sorszamExists.get(sorszam)) {
    sorszam = `${sorszam}#k${key}`;
  }
  const reportedAtIso = parseDateDot(reportedAt);

  const custName = String(r["AKTUÁLIS NÉV"] ?? "").trim() || "(ismeretlen)";
  const zip = r["IRSZ."] ?? null;
  const address = r["CÍM"] ?? null;
  const phone = r["TELEFON"] ?? null;
  const email = r["E-MAIL"] ?? null;
  const technician = r["DOLGOZÓ"] ?? null;
  const status = Number(r["NY/Z"] ?? 0);

  // Auto-categorize from note text.
  const reported = r["BEJELENTETT HIBA"];
  const work = r["ELVÉGZETT MUNKA"];
  const allText = fold([reported, work].filter(Boolean).join(" "));
  const kategoria = categorizeIssue(allText);

  // Insert customer.
  const custRes = dbs.stmts.insertCustomer.run(
    custName,
    fold(custName),
    zip,
    address,
    fold(address),
    phone,
    email,
  ) as { lastInsertRowid: number | bigint };
  const customerId = Number(custRes.lastInsertRowid);

  dbs.stmts.insertJob.run(
    key,
    sorszam,
    reportedAt,
    reportedAtIso,
    customerId,
    technician,
    status,
    kategoria,
    null,
    null,
  );

  // Link to category in junction table.
  if (kategoria) {
    const katRow = dbs.stmts.getProblemaKategoriaByName.get(kategoria) as { id: number } | undefined;
    if (katRow) {
      dbs.stmts.linkTicketProblema.run(key, katRow.id);
    }
  }

  // Devices.
  let devCount = 0;
  const devCell = r["KÉSZÜLÉK TIPUSA"];
  for (const d of parseDeviceCell(devCell)) {
    dbs.stmts.insertDevice.run(
      key,
      d.raw,
      fold(d.raw),
      d.model,
      d.model_ascii,
      d.software,
      d.hardware,
      d.servos,
      d.controller,
      d.machine_type,
      d.freeform,
    );
    devCount++;
  }

  // Notes: reported, work, megjegyzes.
  let noteCount = 0;
  const free = r["MEGJEGYZÉS"];
  if (reported && String(reported).trim() !== "") {
    dbs.stmts.insertNote.run(key, "reported", String(reported), fold(reported), null, null);
    noteCount++;
  }
  if (work && String(work).trim() !== "") {
    dbs.stmts.insertNote.run(key, "work", String(work), fold(work), null, null);
    noteCount++;
  }
  if (free && String(free).trim() !== "") {
    dbs.stmts.insertNote.run(key, "free", String(free), fold(free), null, null);
    noteCount++;
  }

  return { devices: devCount, notes: noteCount };
}

function statMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return Date.now();
  }
}

function log(msg: string, extra: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

const CATEGORY_KEYWORDS: { category: string; keywords: string[] }[] = [
  { category: "Vezérlő hiba", keywords: ["vezerlo", "plc", "nc ", "ncv", "programozas", "tengely", "servo", "encoder", "szabalyzo", "vezérlő", "program"] },
  { category: "Géptípus hiba", keywords: ["tmv", "nct", "niles", "dfs", "géptípus", "konstrukcio", "gyartoi"] },
  { category: "Szoftver hiba", keywords: ["szoftver", "frissites", "verzio", "licenc", "upgrade", "sw-"] },
  { category: "Hardver hiba", keywords: ["hardver", "nyakta", "alaplap", "proci", "memoria", "ram", "rom", "chip", "ic ", "forraszt", "hw:"] },
  { category: "Arampitlasi hiba", keywords: ["aram", "taplgep", "feszultseg", "biztositek", "aramkimarad", "konduktor", "transzform", "overload", "termikus"] },
  { category: "Halozati hiba", keywords: ["halozat", "internet", "wifi", "kabel", "kapcsolat", "tcp", "ip cim", "dhcp", "dns", "switch", "router"] },
  { category: "Mechanikai hiba", keywords: ["mechanikus", "csapagyszij", "lanchajtas", "kopas", "csavar", "alaktart", "geometria", "holtjatek", "szallito"] },
  { category: "Kijelzo hiba", keywords: ["kijelzo", "crt", "lcd", "monitor", "kepernyo", "panel", "touchscreen"] },
  { category: "Tavoli eleres", keywords: ["tavoli", "remote", "vpn", "teamviewer", "anydesk", "rdp", "remote desktop", "tavoli eleres"] },
  { category: "Beallitasi hiba", keywords: ["kalibrallas", "kalibr", "regzal", "nullpont", "poziciona", "parameterez"] },
  { category: "Karbantartas", keywords: ["karbantartas", "tisztitas", "kenes", "ellenorzes", "eloiras", "prevencio", "szerviz"] },
  { category: "Telepites", keywords: ["telepites", "uzembehelyezes", "atalakitas", "beszerel", "atvetel", "inditas"] },
  { category: "Csatlakozasi hiba", keywords: ["csatlakoz", "dugasz", "aljzat", "csatlakozo", "konnektor", "kabel veg"] },
  { category: "Kepzes", keywords: ["kepzes", "oktatas", "taneulas", "dokumentacio", "kezikonyv", "hasznalat"] },
];

function categorizeIssue(foldedText: string): string | null {
  if (!foldedText || foldedText.trim() === "") return null;
  let bestCategory: string | null = null;
  let bestScore = 0;
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    let score = 0;
    for (const kw of keywords) {
      if (foldedText.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }
  return bestScore >= 1 ? bestCategory : "Egyeb";
}

export { tokenize };
