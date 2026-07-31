// Legacy ids look like B00110601, B00111001, B240326002.
// Pattern:  'B' + YYYY(2) + MM(2) + DD(2) + NN(2)   (older, 10 chars)
//        or 'B' + YYYY(2) + MM(2) +  NNN(3)         (newer, 9 chars, e.g. B240326002)
// Either way the first 4 chars after the B are YYMM (2-digit year+month).
// We standardize on a 2-digit year because every existing row uses 2 digits
// (rows from 2000 through 2026+ all have YY in positions 1-2 after the B).
//
// We then need to choose the proper (full) year for the current generation.
// The legacy data jumps from year 99 to 00 and uses 2-digit years, so we
// apply a pivot: if the 2-digit year > current 2-digit year + 10, treat as
// 19xx; else 20xx.

export function yyToFullYear(yy: number, now = new Date()): number {
  const curYY = now.getFullYear() % 100;
  const full = yy > curYY + 10 ? 1900 + yy : 2000 + yy;
  return full;
}

import { Database } from "bun:sqlite";

/**
 * Compute the next sorszam. We deliberately open a fresh read-only
 * connection to the specialized DB file for this query, because in WAL
 * mode the long-lived `dbs.spec` connection has been observed to return
 * a stale snapshot for a subsequent `.query()` after a write transaction
 * commits on the same connection. A fresh connection always sees the
 * latest committed data on disk.
 *
 * Accepts either a `Database` or a path string. If a path is given, a
 * short-lived readonly connection is opened and closed.
 */
export function nextSorszam(
  specOrPath: { query: (sql: string, params?: any[]) => any } | string,
  now: Date = new Date(),
): string {
  const y = now.getFullYear();
  const m = (now.getMonth() + 1).toString().padStart(2, "0");
  const yy = (y % 100).toString().padStart(2, "0");
  const prefix = `B${yy}${m}`;

  let q: (sql: string, params?: any[]) => any;
  let ownedDb: Database | null = null;
  if (typeof specOrPath === "string") {
    // Use a fresh read-write connection. We've observed that opening a
    // readonly connection or a connection that doesn't checkpoint can
    // miss the just-committed WAL data on some platforms when another
    // writer connection still holds prepared statements. A read-write
    // connection with an explicit PASSIVE checkpoint is reliable.
    ownedDb = new Database(specOrPath);
    ownedDb.exec("PRAGMA journal_mode = WAL;");
    ownedDb.exec("PRAGMA busy_timeout = 5000;");
    ownedDb.exec("PRAGMA wal_checkpoint(PASSIVE);");
    const prepared = ownedDb.prepare(`SELECT sorszam FROM jobs`);
    q = (() => {
      return { all: () => prepared.all() };
    }) as any;
  } else {
    q = (sql: string, params?: any[]) => specOrPath.query(sql, params ?? [] as any);
  }

  try {
    const allRows = (typeof specOrPath === "string"
      ? (ownedDb!.prepare(`SELECT sorszam FROM jobs`).all() as { sorszam: string }[])
      : (q(`SELECT sorszam FROM jobs`).all() as { sorszam: string }[])
    );
    const matches = allRows
      .map((r) => r.sorszam)
      .filter((s): s is string => !!s && s.startsWith(prefix));
    matches.sort();
    let next = 1;
    if (matches.length > 0) {
      const tail = matches[matches.length - 1].slice(prefix.length);
      const n = parseInt(tail, 10);
      if (Number.isFinite(n)) next = n + 1;
    }
    const sorszam = `${prefix}${next.toString().padStart(3, "0")}`;
    if (process.env.CMMS_DEBUG_SORSZAM) {
      // eslint-disable-next-line no-console
      console.error("nextSorszam", {
        specOrPath: typeof specOrPath === "string" ? specOrPath : "<db>",
        prefix,
        allCount: allRows.length,
        allRows,
        matches,
        next,
        sorszam,
      });
    }
    return sorszam;
  } finally {
    if (ownedDb) ownedDb.close();
  }
}

export function parseSorszamDate(sorszam: string): { y: number; m: number } | null {
  if (sorszam.length < 7) return null;
  if (sorszam[0] !== "B") return null;
  const yy = parseInt(sorszam.slice(1, 3), 10);
  const mm = parseInt(sorszam.slice(3, 5), 10);
  if (!Number.isFinite(yy) || !Number.isFinite(mm)) return null;
  if (mm < 1 || mm > 12) return null;
  return { y: yyToFullYear(yy), m: mm };
}
