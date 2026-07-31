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

  // ---- failure rates (Phase 2) ----
  // POST /v1/integration/failure-rates
  //   {
  //     product?: string,    // substring on kategoria
  //     year?: number,        // single year
  //     year_from?: number,
  //     year_to?: number,
  //     order_by?: "szazalek" | "hibas_db" | "ossz_gyartott_db" | "ev" (default "szazalek"),
  //     order_dir?: "asc" | "desc" (default "desc"),
  //     limit?: number (default 50, max 500),
  //     language?: "hu" | "en"
  //   }
  // Returns:
  //   { total, products: [{ev, kategoria, hibas_db, ossz_gyartott_db, szazalek,
  //                          gar_db, fiz_db, gar_pct, fiz_pct, trend}], summary_hu, summary_en }
  // trend = (this year - last year) / last year, expressed as a percentage change.
  r.post("/v1/integration/failure-rates", (req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const b = (req.body ?? {}) as {
      product?: string;
      year?: number;
      year_from?: number;
      year_to?: number;
      order_by?: "szazalek" | "hibas_db" | "ossz_gyartott_db" | "ev";
      order_dir?: "asc" | "desc";
      limit?: number;
      language?: "hu" | "en";
    };
    const orderBy = b.order_by ?? "szazalek";
    const orderDir = (b.order_dir ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";
    const allowedOrder = ["szazalek", "hibas_db", "ossz_gyartott_db", "ev", "gar_db", "fiz_db"];
    if (!allowedOrder.includes(orderBy)) {
      res.status(400).json({ error: { code: "bad_request", message: `order_by must be one of ${allowedOrder.join(",")}` } });
      return;
    }
    const limit = Math.min(Number(b.limit ?? 50), 500);

    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (b.product) { where.push("kategoria_ascii LIKE ?"); params.push(`%${foldLike(b.product)}%`); }
    if (b.year != null) { where.push("ev = ?"); params.push(b.year); }
    if (b.year_from != null) { where.push("ev >= ?"); params.push(b.year_from); }
    if (b.year_to != null) { where.push("ev <= ?"); params.push(b.year_to); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const rows = dbs.spec.query(
      `SELECT ev, kategoria, hibas_db, ossz_gyartott_db, szazalek, gar_db, fiz_db
       FROM statisztika ${whereSql}
       ORDER BY ${orderBy} ${orderDir}, kategoria ASC
       LIMIT ?`,
    ).all(...params, limit) as {
      ev: number; kategoria: string; hibas_db: number; ossz_gyartott_db: number;
      szazalek: number; gar_db: number; fiz_db: number;
    }[];

    // Compute gar_pct, fiz_pct, and trend (year-over-year delta on szazalek).
    const byKey = new Map<string, { ev: number; kategoria: string; szazalek: number }>();
    for (const r of rows) byKey.set(`${r.ev}::${r.kategoria}`, r);

    const products = rows.map((r) => {
      const garPct = r.ossz_gyartott_db > 0 ? +(100 * (r.gar_db ?? 0) / r.ossz_gyartott_db).toFixed(2) : null;
      const fizPct = r.ossz_gyartott_db > 0 ? +(100 * (r.fiz_db ?? 0) / r.ossz_gyartott_db).toFixed(2) : null;
      const prev = byKey.get(`${r.ev - 1}::${r.kategoria}`);
      const trend = prev && prev.szazalek > 0
        ? +(((r.szazalek - prev.szazalek) / prev.szazalek) * 100).toFixed(1)
        : null;
      return {
        ev: r.ev,
        kategoria: r.kategoria,
        hibas_db: r.hibas_db,
        ossz_gyartott_db: r.ossz_gyartott_db,
        szazalek: r.szazalek,
        gar_db: r.gar_db,
        fiz_db: r.fiz_db,
        gar_pct: garPct,
        fiz_pct: fizPct,
        trend, // null if no prior year
      };
    });

    // Bilingual summary: top-3 worst.
    const worst = [...products].sort((a, b) => b.szazalek - a.szazalek).slice(0, 3);
    const summary_hu = worst.length
      ? `A legmagasabb meghibásodási arány: ${worst.map((w) => `${w.kategoria} ${w.ev}: ${w.szazalek.toFixed(2)}%`).join(", ")}.`
      : "Nincs elérhető statisztika.";
    const summary_en = worst.length
      ? `Worst failure rates: ${worst.map((w) => `${w.kategoria} ${w.ev}: ${w.szazalek.toFixed(2)}%`).join(", ")}.`
      : "No failure-rate data available.";

    res.json({
      total: products.length,
      filters: { product: b.product ?? null, year: b.year ?? null, year_from: b.year_from ?? null, year_to: b.year_to ?? null, order_by: orderBy, order_dir: orderDir.toLowerCase() },
      products,
      summary_hu,
      summary_en,
    });
  });

  // ---- spare motor (Phase 2) ----
  // POST /v1/integration/spare-motor
  //   {
  //     machine_serial?: string,   // gép azonosító, pl. "M16119"
  //     motor_type?: string,       // pl. "AiS100", "AiS132", "Baumüller"
  //     problema?: string,          // pl. "zárlatos", "szigetelés"
  //     free_text?: string,         // FTS5 query across all motor fields
  //     available_only?: boolean,   // exclude motors with a 'feladat' indicating used/spoken-for
  //     limit?: number (default 20, max 100)
  //   }
  // Returns ordered list of motor rows with a `match_score` (0..1) reflecting
  // how well the motor matches the requested machine + type combination.
  r.post("/v1/integration/spare-motor", (req, res) => {
    if (!ready()) { res.status(503).json({ error: { code: "not_ready" } }); return; }
    const b = (req.body ?? {}) as {
      machine_serial?: string; motor_type?: string; problema?: string;
      free_text?: string; available_only?: boolean; limit?: number;
    };
    const limit = Math.min(Number(b.limit ?? 20), 100);

    let rows: Record<string, unknown>[] = [];
    let source: "fts" | "filtered" = "filtered";

    if (b.free_text && b.free_text.length >= 2) {
      source = "fts";
      rows = dbs.spec.query(
        `SELECT s.* FROM telephely_ais_motor_fts f
         JOIN telephely_ais_motor s ON s.id = f.rowid
         WHERE telephely_ais_motor_fts MATCH ?
         LIMIT ?`,
      ).all(ftsQuery(b.free_text), limit * 4) as Record<string, unknown>[];
    } else {
      const where: string[] = [];
      const params: SQLQueryBindings[] = [];
      if (b.motor_type) { where.push("tipus = ?"); params.push(b.motor_type); }
      if (b.machine_serial) { where.push("melyik_gepeken_volt_ascii LIKE ?"); params.push(`%${foldLike(b.machine_serial)}%`); }
      if (b.problema) { where.push("problema_ascii LIKE ?"); params.push(`%${foldLike(b.problema)}%`); }
      if (b.available_only) {
        // "available" = no feladat (planned disposition). We treat empty feladat as available.
        where.push("(feladat IS NULL OR feladat = '' OR feladat = '---')");
      }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
      rows = dbs.spec.query(
        `SELECT * FROM telephely_ais_motor ${whereSql}
         ORDER BY id ASC
         LIMIT ?`,
      ).all(...params, limit * 4) as Record<string, unknown>[];
    }

    // Score each row: how well does it match the requested combo?
    // type exact match: +0.5
    // machine_serial substring match in melyik_gepeken_volt: +0.4
    // problema substring match: +0.1
    // no feladat (free): +0.05
    const typeQ = b.motor_type?.toLowerCase() ?? "";
    const serialQ = b.machine_serial ? foldLike(b.machine_serial) : "";
    const probQ = b.problema ? foldLike(b.problema) : "";
    const scored = rows.map((r) => {
      const tipus = String(r.tipus ?? "").toLowerCase();
      const gep   = String(r.melyik_gepeken_volt_ascii ?? "");
      const prob  = String(r.problema_ascii ?? "");
      const fel   = String(r.feladat ?? "");
      let score = 0;
      if (typeQ && tipus === typeQ) score += 0.5;
      else if (typeQ && tipus.includes(typeQ)) score += 0.2;
      if (serialQ && gep.includes(serialQ)) score += 0.4;
      if (probQ && prob.includes(probQ)) score += 0.1;
      if (!fel || fel === "---") score += 0.05;
      return { ...r, match_score: +score.toFixed(2) };
    });
    scored.sort((a, b) => (b.match_score as number) - (a.match_score as number));
    const top = scored.slice(0, limit);

    res.json({
      total: scored.length,
      returned: top.length,
      source,
      filters: {
        machine_serial: b.machine_serial ?? null,
        motor_type: b.motor_type ?? null,
        problema: b.problema ?? null,
        free_text: b.free_text ?? null,
        available_only: !!b.available_only,
      },
      motors: top,
      best_match: top[0] ?? null,
    });
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
