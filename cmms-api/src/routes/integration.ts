// Read-only routes for the integrated CMMS CSV data
// (serviz_belso, szev_igeny, telephely_munka, telephely_ais_motor,
//  nem_javitjuk, statisztika).
//
// All endpoints require the read token. They never mutate state.
//
// The data is loaded into the same cmms_specialized.db (via
// src/db/integration.ts) and exposed under /v1/integration/*.

import express from "express";
import type { SQLQueryBindings } from "bun:sqlite";
import type { OpenDbs } from "../db/open";

export function integrationRouter(dbs: OpenDbs): express.Router {
  const r = express.Router();

  // Whether the integration DB is loaded and queryable.
  function ready(): boolean {
    try {
      const row = dbs.spec.query("SELECT name FROM sqlite_master WHERE type='table' AND name='serviz_belso'").get();
      return !!row;
    } catch {
      return false;
    }
  }

  // GET /v1/integration/health
  r.get("/v1/integration/health", (_req, res) => {
    if (!ready()) {
      res.json({ ok: false, reason: "integration tables not present" });
      return;
    }
    const counts = {
      serviz_belso:          (dbs.spec.query("SELECT COUNT(*) AS n FROM serviz_belso").get() as { n: number }).n,
      szev_igeny:            (dbs.spec.query("SELECT COUNT(*) AS n FROM szev_igeny").get() as { n: number }).n,
      telephely_munka:       (dbs.spec.query("SELECT COUNT(*) AS n FROM telephely_munka").get() as { n: number }).n,
      telephely_ais_motor:   (dbs.spec.query("SELECT COUNT(*) AS n FROM telephely_ais_motor").get() as { n: number }).n,
      nem_javitjuk:          (dbs.spec.query("SELECT COUNT(*) AS n FROM nem_javitjuk").get() as { n: number }).n,
      statisztika:           (dbs.spec.query("SELECT COUNT(*) AS n FROM statisztika").get() as { n: number }).n,
    };
    const meta = dbs.spec.query("SELECT key, value FROM _meta WHERE key LIKE 'integration_%'").all() as { key: string; value: string }[];
    res.json({ ok: true, counts, meta: Object.fromEntries(meta.map((m) => [m.key, m.value])) });
  });

  // ---- serviz_belso ----
  // GET /v1/integration/serviz/search
  //   q, j_szam, cegnev, eszkoz, dolgozo, date_from, date_to, year (via source_period),
  //   limit (max 200), offset
  r.get("/v1/integration/serviz/search", (req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const q = (req.query.q as string | undefined)?.trim();
    const j_szam = (req.query.j_szam as string | undefined)?.trim();
    const cegnev = (req.query.cegnev as string | undefined)?.trim();
    const eszkoz = (req.query.eszkoz as string | undefined)?.trim();
    const dolgozo = (req.query.dolgozo as string | undefined)?.trim();
    const dateFrom = (req.query.date_from as string | undefined)?.trim();
    const dateTo = (req.query.date_to as string | undefined)?.trim();
    const sourcePeriod = (req.query.source_period as string | undefined)?.trim();
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    // If q is given, prefer the FTS5 path for speed.
    if (q && q.length >= 2) {
      const fts = dbs.spec.query(
        `SELECT s.* FROM serviz_belso_fts f
         JOIN serviz_belso s ON s.id = f.rowid
         WHERE serviz_belso_fts MATCH ?
         LIMIT ?`,
      ).all(ftsQuery(q), limit) as Record<string, unknown>[];
      res.json({ total: fts.length, offset: 0, limit, jobs: fts, source: "fts" });
      return;
    }

    // Filtered query (no FTS).
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (j_szam) { where.push("j_szam LIKE ?"); params.push(`%${j_szam}%`); }
    if (cegnev) { where.push("cegnev_ascii LIKE ?"); params.push(foldLike(cegnev)); }
    if (eszkoz) { where.push("eszkoz_ascii LIKE ?"); params.push(foldLike(eszkoz)); }
    if (dolgozo) { where.push("dolgozo LIKE ?"); params.push(`%${dolgozo}%`); }
    if (dateFrom) { where.push("datum_iso >= ?"); params.push(dateFrom); }
    if (dateTo) { where.push("datum_iso <= ?"); params.push(dateTo); }
    if (sourcePeriod) { where.push("source_period = ?"); params.push(sourcePeriod); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const totalRow = dbs.spec.query(`SELECT COUNT(*) AS n FROM serviz_belso ${whereSql}`).get(...params) as { n: number };
    const rows = dbs.spec.query(
      `SELECT * FROM serviz_belso ${whereSql}
       ORDER BY datum_iso DESC NULLS LAST, id DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Record<string, unknown>[];
    res.json({ total: totalRow.n, offset, limit, jobs: rows });
  });

  // GET /v1/integration/serviz/by-j-szam?j=J00001
  r.get("/v1/integration/serviz/by-j-szam", (req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const j = (req.query.j as string | undefined)?.trim();
    if (!j) { res.status(400).json({ error: { code: "bad_request", message: "missing j" } }); return; }
    const rows = dbs.spec.query(
      `SELECT * FROM serviz_belso WHERE j_szam = ? ORDER BY id DESC`,
    ).all(j) as Record<string, unknown>[];
    res.json({ total: rows.length, jobs: rows });
  });

  // ---- szev_igeny ----
  r.get("/v1/integration/szev/search", (req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const q = (req.query.q as string | undefined)?.trim();
    const megrendelo = (req.query.megrendelo as string | undefined)?.trim();
    const geptipus = (req.query.geptipus as string | undefined)?.trim();
    const munkaszam = (req.query.munkaszam as string | undefined)?.trim();
    const year = req.query.year ? Number(req.query.year) : null;
    const felelos = (req.query.felelos as string | undefined)?.trim();
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    if (q && q.length >= 2) {
      const fts = dbs.spec.query(
        `SELECT s.* FROM szev_igeny_fts f
         JOIN szev_igeny s ON s.id = f.rowid
         WHERE szev_igeny_fts MATCH ?
         LIMIT ?`,
      ).all(ftsQuery(q), limit) as Record<string, unknown>[];
      res.json({ total: fts.length, offset: 0, limit, jobs: fts, source: "fts" });
      return;
    }
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (megrendelo) { where.push("megrendelo_ascii LIKE ?"); params.push(foldLike(megrendelo)); }
    if (geptipus)   { where.push("geptipus LIKE ?"); params.push(`%${geptipus}%`); }
    if (munkaszam)  { where.push("munkaszam LIKE ?"); params.push(`%${munkaszam}%`); }
    if (felelos)    { where.push("felelos LIKE ?"); params.push(`%${felelos}%`); }
    if (year)       { where.push("year = ?"); params.push(year); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = dbs.spec.query(`SELECT COUNT(*) AS n FROM szev_igeny ${whereSql}`).get(...params) as { n: number };
    const rows = dbs.spec.query(
      `SELECT * FROM szev_igeny ${whereSql}
       ORDER BY year DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Record<string, unknown>[];
    res.json({ total: total.n, offset, limit, jobs: rows });
  });

  // ---- telephely_munka ----
  r.get("/v1/integration/telephely/search", (req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const q = (req.query.q as string | undefined)?.trim();
    const megrendelo = (req.query.megrendelo as string | undefined)?.trim();
    const geptipus = (req.query.geptipus as string | undefined)?.trim();
    const munkaszam = (req.query.munkaszam as string | undefined)?.trim();
    const year = req.query.year ? Number(req.query.year) : null;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    if (q && q.length >= 2) {
      const fts = dbs.spec.query(
        `SELECT s.* FROM telephely_munka_fts f
         JOIN telephely_munka s ON s.id = f.rowid
         WHERE telephely_munka_fts MATCH ?
         LIMIT ?`,
      ).all(ftsQuery(q), limit) as Record<string, unknown>[];
      res.json({ total: fts.length, offset: 0, limit, jobs: fts, source: "fts" });
      return;
    }
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (megrendelo) { where.push("megrendelo_ascii LIKE ?"); params.push(foldLike(megrendelo)); }
    if (geptipus)   { where.push("geptipus_ascii LIKE ?"); params.push(foldLike(geptipus)); }
    if (munkaszam)  { where.push("munkaszam LIKE ?"); params.push(`%${munkaszam}%`); }
    if (year)       { where.push("year = ?"); params.push(year); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = dbs.spec.query(`SELECT COUNT(*) AS n FROM telephely_munka ${whereSql}`).get(...params) as { n: number };
    const rows = dbs.spec.query(
      `SELECT * FROM telephely_munka ${whereSql}
       ORDER BY beerkezes_iso DESC NULLS LAST, id DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Record<string, unknown>[];
    res.json({ total: total.n, offset, limit, jobs: rows });
  });

  // ---- telephely_ais_motor ----
  r.get("/v1/integration/ais/search", (req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const q = (req.query.q as string | undefined)?.trim();
    const tipus = (req.query.tipus as string | undefined)?.trim();
    const gep = (req.query.gep as string | undefined)?.trim();
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    if (q && q.length >= 2) {
      const fts = dbs.spec.query(
        `SELECT s.* FROM telephely_ais_motor_fts f
         JOIN telephely_ais_motor s ON s.id = f.rowid
         WHERE telephely_ais_motor_fts MATCH ?
         LIMIT ?`,
      ).all(ftsQuery(q), limit) as Record<string, unknown>[];
      res.json({ total: fts.length, offset: 0, limit, jobs: fts, source: "fts" });
      return;
    }
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (tipus) { where.push("tipus = ?"); params.push(tipus); }
    if (gep)   { where.push("melyik_gepeken_volt_ascii LIKE ?"); params.push(foldLike(gep)); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = dbs.spec.query(`SELECT COUNT(*) AS n FROM telephely_ais_motor ${whereSql}`).get(...params) as { n: number };
    const rows = dbs.spec.query(
      `SELECT * FROM telephely_ais_motor ${whereSql}
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Record<string, unknown>[];
    res.json({ total: total.n, offset, limit, jobs: rows });
  });

  // ---- statisztika ----
  r.get("/v1/integration/statisztika/search", (req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const ev = req.query.ev ? Number(req.query.ev) : null;
    const kategoria = (req.query.kategoria as string | undefined)?.trim();
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (ev) { where.push("ev = ?"); params.push(ev); }
    if (kategoria) { where.push("kategoria_ascii LIKE ?"); params.push(foldLike(kategoria)); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = dbs.spec.query(`SELECT COUNT(*) AS n FROM statisztika ${whereSql}`).get(...params) as { n: number };
    const rows = dbs.spec.query(
      `SELECT * FROM statisztika ${whereSql}
       ORDER BY ev DESC, kategoria ASC
       LIMIT ?`,
    ).all(...params, limit) as Record<string, unknown>[];
    res.json({ total: total.n, limit, jobs: rows });
  });

  // ---- nem_javitjuk ----
  r.get("/v1/integration/nem-javitjuk/list", (req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const rows = dbs.spec.query(
      `SELECT * FROM nem_javitjuk ORDER BY datum_iso DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    res.json({ total: rows.length, jobs: rows });
  });

  // ---- integration-wide stats ----
  r.get("/v1/integration/stats", (_req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const byYearSzev = dbs.spec.query(
      "SELECT year, COUNT(*) AS n FROM szev_igeny GROUP BY year ORDER BY year",
    ).all() as { year: number; n: number }[];
    const bySource = dbs.spec.query(
      "SELECT source_period, COUNT(*) AS n FROM serviz_belso GROUP BY source_period",
    ).all() as { source_period: string; n: number }[];
    const byTipus = dbs.spec.query(
      "SELECT tipus, COUNT(*) AS n FROM telephely_ais_motor WHERE tipus IS NOT NULL GROUP BY tipus ORDER BY n DESC LIMIT 15",
    ).all() as { tipus: string; n: number }[];
    res.json({
      szev_by_year: byYearSzev,
      serviz_by_source: bySource.map((r) => ({ source: r.source_period, n: r.n })),
      ais_by_tipus: byTipus,
    });
  });

  return r;
}

// Fold a Hungarian string to ASCII lowercase for accent-insensitive LIKE.
function foldLike(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Build a defensive FTS5 prefix query: each token gets a trailing * so
// partial words match. Wrap in double quotes if the user already used
// FTS5 syntax to avoid breaking the query.
function ftsQuery(q: string): string {
  if (q.includes('"') || q.includes(':') || q.includes('(') || q.includes(')')) {
    return q; // assume caller knows FTS5
  }
  return q.split(/\s+/).filter(Boolean).map((t) => `${t}*`).join(" ");
}
