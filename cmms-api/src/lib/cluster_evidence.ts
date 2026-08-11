// Cross-DB evidence for problem clusters (Phase 5a).
//
// When a recurring-problem cluster is returned to the LLM, it should also
// answer the implicit question "did this same problem show up in the
// integrated archives?". This module adds that evidence by looking up
// the cluster's signature (customer + machine) in the spec DB tables:
// serviz_belso, szev_igeny, telephely_munka.
//
// Matching strategy mirrors related.ts:
//   - customer: fold-normalized bidirectional substring
//   - machine:  fold+strip-normalized substring
//   - date:     no date filter here — the cluster already has its own
//               date window via the caller, and the spec tables have
//               overlapping but distinct date semantics.
//
// Returned shape is intentionally compact — 1-2 rows per source, with
// short snippets — to keep the response small and let the LLM cite
// the strongest match for each archive.

import type { OpenDbs } from "../db/open";
import type { ProblemCluster, SignatureFilter } from "./cluster";

export type ClusterEvidenceEntry = {
  source: "serviz_belso" | "szev_igeny" | "telephely_munka";
  id: string;
  date: string | null;
  customer: string | null;
  machine_type: string | null;
  snippet: string;
};

export type ClusterEvidence = {
  serviz_belso: ClusterEvidenceEntry[];
  szev_igeny: ClusterEvidenceEntry[];
  telephely_munka: ClusterEvidenceEntry[];
  total: number;
};

/** Fold diacritics + lowercase. Local copy to avoid importing parse.ts. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function foldMachine(s: string): string {
  return fold(s).replace(/[-\s]/g, "");
}

function tableExists(dbs: OpenDbs, name: string): boolean {
  try {
    const r = dbs.spec.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) as { 1?: number } | null;
    return !!r;
  } catch {
    return false;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

/**
 * Look up cross-DB evidence for a cluster.
 *
 * @param dbs       the spec DB connection
 * @param signature the cluster's active signature (customer / machine etc.)
 * @param opts.limit max rows per source (default 2)
 * @param opts.window_days how far back to search (default null = no date filter)
 * @param opts.ref_date reference date for window_days (default null = no filter)
 */
export function clusterEvidence(
  dbs: OpenDbs,
  signature: SignatureFilter,
  opts: { limit?: number; window_days?: number; ref_date?: string | null } = {},
): ClusterEvidence {
  const limit = Math.max(0, Math.min(10, opts.limit ?? 2));
  const customer = signature.customer?.trim() || null;
  const machine = signature.machine?.trim() || null;
  const out: ClusterEvidence = {
    serviz_belso: [],
    szev_igeny: [],
    telephely_munka: [],
    total: 0,
  };

  // No seed → nothing to look up.
  if (!customer && !machine) return out;

  if (limit > 0 && tableExists(dbs, "serviz_belso")) {
    out.serviz_belso = searchServizBelso(dbs, customer, machine, limit, opts.window_days, opts.ref_date);
  }
  if (limit > 0 && tableExists(dbs, "szev_igeny")) {
    out.szev_igeny = searchSzevIgeny(dbs, customer, machine, limit, opts.window_days, opts.ref_date);
  }
  if (limit > 0 && tableExists(dbs, "telephely_munka")) {
    out.telephely_munka = searchTelephelyMunka(dbs, customer, machine, limit, opts.window_days, opts.ref_date);
  }

  out.total = out.serviz_belso.length + out.szev_igeny.length + out.telephely_munka.length;
  return out;
}

/**
 * Enrich a list of clusters with cross-DB evidence. Mutates the input
 * clusters in place (adds `related_integration` field) and returns the
 * same array for convenience. Missing spec tables yield empty arrays.
 */
export function enrichClustersWithEvidence(
  dbs: OpenDbs,
  clusters: ProblemCluster[],
  opts: { limit?: number; window_days?: number } = {},
): ProblemCluster[] {
  for (const c of clusters) {
    // Use the cluster's active signature, not the original filter —
    // the active fields are the ones the cluster tickets all agree on,
    // which is what makes the cluster "real".
    const ev = clusterEvidence(dbs, c.signature, opts);
    (c as ProblemCluster & { related_integration: ClusterEvidence }).related_integration = ev;
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// Per-source lookups
// ---------------------------------------------------------------------------

function searchServizBelso(
  dbs: OpenDbs,
  customer: string | null,
  machine: string | null,
  limit: number,
  windowDays?: number,
  refDate?: string | null,
): ClusterEvidenceEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (customer) {
    where.push("cegnev_ascii LIKE ?");
    params.push(`%${fold(customer)}%`);
  }
  if (machine) {
    where.push("eszkoz_ascii LIKE ?");
    params.push(`%${foldMachine(machine)}%`);
  }
  if (windowDays && refDate) {
    const ws = new Date(Date.parse(refDate) - windowDays * 86_400_000).toISOString().slice(0, 10);
    const we = new Date(Date.parse(refDate) + windowDays * 86_400_000).toISOString().slice(0, 10);
    where.push("datum_iso >= ?");
    params.push(ws);
    where.push("datum_iso <= ?");
    params.push(we);
  }
  if (where.length === 0) return [];
  let rows: Record<string, unknown>[];
  try {
    rows = dbs.spec.query(
      `SELECT j_szam, datum_iso, cegnev, eszkoz, hibajelenseg, vegzett_munka
       FROM serviz_belso
       WHERE ${where.join(" AND ")}
       ORDER BY datum_iso DESC NULLS LAST
       LIMIT ?`,
    ).all(...params, limit) as Record<string, unknown>[];
  } catch {
    return [];
  }
  return rows.map((r) => {
    const hiba = String(r.hibajelenseg ?? "");
    const munka = String(r.vegzett_munka ?? "");
    const snippetText = hiba || munka || "(no description)";
    return {
      source: "serviz_belso" as const,
      id: String(r.j_szam ?? "?"),
      date: r.datum_iso ? String(r.datum_iso) : null,
      customer: r.cegnev ? String(r.cegnev) : null,
      machine_type: r.eszkoz ? String(r.eszkoz) : null,
      snippet: truncate(snippetText, 200),
    };
  });
}

function searchSzevIgeny(
  dbs: OpenDbs,
  customer: string | null,
  machine: string | null,
  limit: number,
  windowDays?: number,
  refDate?: string | null,
): ClusterEvidenceEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (customer) {
    where.push("megrendelo_ascii LIKE ?");
    params.push(`%${fold(customer)}%`);
  }
  if (machine) {
    where.push("geptipus LIKE ?");
    params.push(`%${fold(machine)}%`);
  }
  if (windowDays && refDate) {
    const ws = new Date(Date.parse(refDate) - windowDays * 86_400_000).toISOString().slice(0, 10);
    const we = new Date(Date.parse(refDate) + windowDays * 86_400_000).toISOString().slice(0, 10);
    where.push("igeny_datum_iso >= ?");
    params.push(ws);
    where.push("igeny_datum_iso <= ?");
    params.push(we);
  }
  if (where.length === 0) return [];
  let rows: Record<string, unknown>[];
  try {
    rows = dbs.spec.query(
      `SELECT szev_szam, igeny_datum_iso, megrendelo, geptipus, igeny
       FROM szev_igeny
       WHERE ${where.join(" AND ")}
       ORDER BY igeny_datum_iso DESC NULLS LAST
       LIMIT ?`,
    ).all(...params, limit) as Record<string, unknown>[];
  } catch {
    return [];
  }
  return rows.map((r) => {
    const igeny = String(r.igeny ?? "");
    return {
      source: "szev_igeny" as const,
      id: String(r.szev_szam ?? "?"),
      date: r.igeny_datum_iso ? String(r.igeny_datum_iso) : null,
      customer: r.megrendelo ? String(r.megrendelo) : null,
      machine_type: r.geptipus ? String(r.geptipus) : null,
      snippet: truncate(igeny || "(no description)", 200),
    };
  });
}

function searchTelephelyMunka(
  dbs: OpenDbs,
  customer: string | null,
  machine: string | null,
  limit: number,
  windowDays?: number,
  refDate?: string | null,
): ClusterEvidenceEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (customer) {
    where.push("megrendelo_ascii LIKE ?");
    params.push(`%${fold(customer)}%`);
  }
  if (machine) {
    where.push("geptipus_ascii LIKE ?");
    params.push(`%${foldMachine(machine)}%`);
  }
  if (windowDays && refDate) {
    const ws = new Date(Date.parse(refDate) - windowDays * 86_400_000).toISOString().slice(0, 10);
    const we = new Date(Date.parse(refDate) + windowDays * 86_400_000).toISOString().slice(0, 10);
    where.push("(beerkezes_iso >= ? OR kikuldes_iso >= ?)");
    params.push(ws, ws);
    where.push("(beerkezes_iso <= ? OR kikuldes_iso <= ?)");
    params.push(we, we);
  }
  if (where.length === 0) return [];
  let rows: Record<string, unknown>[];
  try {
    rows = dbs.spec.query(
      `SELECT sorszam, beerkezes_iso, kikuldes_iso, megrendelo, geptipus, hibajelenseg
       FROM telephely_munka
       WHERE ${where.join(" AND ")}
       ORDER BY beerkezes_iso DESC NULLS LAST
       LIMIT ?`,
    ).all(...params, limit) as Record<string, unknown>[];
  } catch {
    return [];
  }
  return rows.map((r) => {
    const hiba = String(r.hibajelenseg ?? "");
    return {
      source: "telephely_munka" as const,
      id: r.sorszam ? String(r.sorszam) : "?",
      date: r.beerkezes_iso ? String(r.beerkezes_iso) : (r.kikuldes_iso ? String(r.kikuldes_iso) : null),
      customer: r.megrendelo ? String(r.megrendelo) : null,
      machine_type: r.geptipus ? String(r.geptipus) : null,
      snippet: truncate(hiba || "(no description)", 200),
    };
  });
}
