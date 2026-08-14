// Cross-database "find related tickets" logic (Phase 4).
//
// Given a seed ticket (by sorszam) or a customer+device combo, this module
// searches across ALL data sources — main CMMS tickets (cmms.db),
// serviz_belso, szev_igeny, telephely_munka — and returns a chronological
// timeline of related entries.
//
// Matching strategy:
//   1. Customer name: fold-normalized substring match (bidirectional).
//      "ANDRITZ" matches "ANDRITZ KFT." and "ANDRITZ Magyarország Kft."
//   2. Machine type: fold+strip-normalized substring match.
//      "DPB-2" matches "DPB 2", "DPB2000" does NOT match "DPB-2".
//   3. Date proximity: entries within ±window_days of the seed date.
//
// The seed itself is always included in the results so the LLM can
// present a complete narrative.

import type { JobCache, JobCard } from "../cache/jobs";
import type { OpenDbs } from "../db/open";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimelineEntry = {
  source: "cmms" | "serviz_belso" | "szev_igeny" | "telephely_munka";
  /** Primary identifier in the source. */
  id: string;
  /** ISO date (best-effort, may be null). */
  date: string | null;
  /** Customer / company name (raw from source). */
  customer: string | null;
  /** Machine type / equipment description. */
  machine_type: string | null;
  /** Fault description or kategoria. */
  fault: string | null;
  /** Work done or request description. */
  description: string | null;
  /** Technician or responsible person. */
  person: string | null;
  /** Snippet (short text, ≤200 chars). */
  snippet: string;
  /** Match score 0..1 — how closely this entry relates to the seed. */
  relevance: number;
};

export type RelatedResult = {
  seed: {
    sorszam: string;
    customer: string | null;
    machine_type: string | null;
    date: string | null;
  } | null;
  window_days: number;
  timeline: TimelineEntry[];
  total: number;
  sources_searched: string[];
};

export type RelatedOpts = {
  sorszam?: string;
  customer?: string;
  device?: string;
  period?: string;
  window_days?: number;
  limit?: number;
  language?: "hu" | "en";
};

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Fold diacritics + lowercase. Used for customer name matching. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Fold + strip hyphens/spaces for machine type matching. */
function foldMachine(s: string): string {
  return fold(s).replace(/[-\s]/g, "");
}

/** Check if two strings are "related" via bidirectional substring match. */
function matchesCustomer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const fa = fold(a);
  const fb = fold(b);
  if (fa === fb) return true;
  // Bidirectional substring: "ANDRITZ" ∈ "ANDRITZ KFT." and vice versa.
  return fa.includes(fb) || fb.includes(fa);
}

/** Check if two machine types are related (normalized substring). */
function matchesMachine(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const fa = foldMachine(a);
  const fb = foldMachine(b);
  if (fa === fb) return true;
  return fa.includes(fb) || fb.includes(fa);
}

/**
 * Check if a device row matches a seed device string. Mirrors the
 * JobCache.search device filter: machine_type via normalized substring,
 * AND model/raw via fold+strip substring. This is what makes serial
 * numbers searchable — e.g. "M17191" lives inside the raw device string
 * ("DPB-2(10297;M17191);NCT104;…") but NOT in machine_type ("DPB-2").
 * Without this, find_related_tickets returned 0 while search returned 62.
 */
function matchesDevice(
  d: { machine_type: string | null; model?: string | null; raw?: string | null },
  seed: string,
): boolean {
  if (matchesMachine(d.machine_type, seed)) return true;
  const seedFolded = foldMachine(seed);
  if (!seedFolded) return false;
  const m = d.model ? foldMachine(d.model) : "";
  const r = d.raw ? foldMachine(d.raw) : "";
  return m.includes(seedFolded) || r.includes(seedFolded);
}

/** Check if a date is within ±windowDays of a reference date. */
function inWindow(dateIso: string | null, refDate: string | null, windowDays: number): boolean {
  if (!dateIso || !refDate) return true; // if either date is missing, include
  const a = Date.parse(dateIso);
  const b = Date.parse(refDate);
  if (isNaN(a) || isNaN(b)) return true;
  const diffMs = Math.abs(a - b);
  return diffMs <= windowDays * 86_400_000;
}

/** Date proximity score: 1.0 if same day, decays to 0 at window edge. */
function dateProximity(dateIso: string | null, refDate: string | null, windowDays: number): number {
  if (!dateIso || !refDate) return 0.5; // unknown = neutral
  const a = Date.parse(dateIso);
  const b = Date.parse(refDate);
  if (isNaN(a) || isNaN(b)) return 0.5;
  const diffDays = Math.abs(a - b) / 86_400_000;
  return Math.max(0, 1 - diffDays / windowDays);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function findRelated(
  cache: JobCache,
  dbs: OpenDbs,
  opts: RelatedOpts,
): RelatedResult {
  const windowDays = opts.window_days ?? 180;
  const limit = opts.limit ?? 50;

  // 1. Resolve the seed ticket.
  let seedCard: JobCard | null = null;
  if (opts.sorszam) {
    for (const card of cache.allJobs()) {
      if (card.sorszam.toUpperCase() === opts.sorszam!.toUpperCase()) {
        seedCard = card;
        break;
      }
    }
  }

  const seedCustomer = seedCard?.customer.name ?? opts.customer ?? null;
  const seedDevice = seedCard?.devices[0]?.machine_type ?? opts.device ?? null;
  const seedDate = seedCard?.reported_at_iso ?? null;

  const seed = seedCard ? {
    sorszam: seedCard.sorszam,
    customer: seedCard.customer.name,
    machine_type: seedCard.devices[0]?.machine_type ?? null,
    date: seedCard.reported_at_iso,
  } : (seedCustomer || seedDevice) ? {
    sorszam: "(search)",
    customer: seedCustomer,
    machine_type: seedDevice,
    date: null,
  } : null;

  // 2. Search across all sources.
  const entries: TimelineEntry[] = [];
  const sourcesSearched = ["cmms"];

  // 2a. Main CMMS tickets
  const cmmsHits = searchCmms(cache, seedCustomer, seedDevice, seedDate, windowDays);
  entries.push(...cmmsHits);

  // 2b. serviz_belso
  if (tableExists(dbs, "serviz_belso")) {
    sourcesSearched.push("serviz_belso");
    const sbHits = searchServizBelso(dbs, seedCustomer, seedDevice, seedDate, windowDays);
    entries.push(...sbHits);
  }

  // 2c. szev_igeny
  if (tableExists(dbs, "szev_igeny")) {
    sourcesSearched.push("szev_igeny");
    const szHits = searchSzevIgeny(dbs, seedCustomer, seedDevice, seedDate, windowDays);
    entries.push(...szHits);
  }

  // 2d. telephely_munka
  if (tableExists(dbs, "telephely_munka")) {
    sourcesSearched.push("telephely_munka");
    const tmHits = searchTelephelyMunka(dbs, seedCustomer, seedDevice, seedDate, windowDays);
    entries.push(...tmHits);
  }

  // 3. Sort chronologically (nulls last).
  entries.sort((a, b) => {
    const da = a.date ?? "9999";
    const db = b.date ?? "9999";
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
  });

  // 4. Cap at limit.
  const capped = entries.slice(0, limit);

  return {
    seed,
    window_days: windowDays,
    timeline: capped,
    total: entries.length,
    sources_searched: sourcesSearched,
  };
}

// ---------------------------------------------------------------------------
// Per-source search functions
// ---------------------------------------------------------------------------

function searchCmms(
  cache: JobCache,
  seedCustomer: string | null,
  seedDevice: string | null,
  seedDate: string | null,
  windowDays: number,
): TimelineEntry[] {
  if (!seedCustomer && !seedDevice) return [];

  const results: TimelineEntry[] = [];
  for (const card of cache.allJobs()) {
    // Must match customer OR machine (or both if both specified).
    const custMatch = seedCustomer ? matchesCustomer(card.customer.name, seedCustomer) : false;
    const devMatch = seedDevice
      ? card.devices.some((d) => matchesDevice(d, seedDevice))
      : false;

    if (!custMatch && !devMatch) continue;

    // Date proximity filter.
    if (seedDate && !inWindow(card.reported_at_iso, seedDate, windowDays)) continue;

    // Relevance score: customer match (0.4) + machine match (0.3) + date proximity (0.3).
    const custScore = custMatch ? 0.4 : 0;
    const devScore = devMatch ? 0.3 : 0;
    const dateScore = dateProximity(card.reported_at_iso, seedDate, windowDays) * 0.3;
    const relevance = +(custScore + devScore + dateScore).toFixed(2);

    const reported = card.notes.find((n) => n.kind === "reported");
    const work = card.notes.find((n) => n.kind === "work");
    const free = card.notes.find((n) => n.kind === "free");
    const snippetSource = (reported?.body) || (work?.body) || (free?.body) || "";
    const snippet = snippetSource.length > 200 ? snippetSource.slice(0, 197) + "..." : snippetSource;

    results.push({
      source: "cmms",
      id: card.sorszam,
      date: card.reported_at_iso,
      customer: card.customer.name,
      machine_type: card.devices[0]?.machine_type ?? null,
      fault: card.problem_kategoria ?? card.kategoria_inferred ?? null,
      description: reported?.body ?? null,
      person: card.technician,
      snippet,
      relevance,
    });
  }

  return results;
}

function searchServizBelso(
  dbs: OpenDbs,
  seedCustomer: string | null,
  seedDevice: string | null,
  seedDate: string | null,
  windowDays: number,
): TimelineEntry[] {
  if (!seedCustomer && !seedDevice) return [];

  // Build query: customer match is mandatory if provided; machine is optional filter.
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (seedCustomer) {
    where.push("cegnev_ascii LIKE ?");
    params.push(`%${fold(seedCustomer)}%`);
  }
  if (seedDevice) {
    where.push("eszkoz_ascii LIKE ?");
    params.push(`%${fold(seedDevice)}%`);
  }
  // Date window (broad filter to avoid pulling too many rows).
  if (seedDate) {
    const windowStart = new Date(Date.parse(seedDate) - windowDays * 86_400_000).toISOString().slice(0, 10);
    const windowEnd = new Date(Date.parse(seedDate) + windowDays * 86_400_000).toISOString().slice(0, 10);
    where.push("datum_iso >= ?");
    params.push(windowStart);
    where.push("datum_iso <= ?");
    params.push(windowEnd);
  }

  if (where.length === 0) return [];

  const whereSql = "WHERE " + where.join(" AND ");
  let rows: Record<string, unknown>[];
  try {
    rows = dbs.spec.query(
      `SELECT * FROM serviz_belso ${whereSql} ORDER BY datum_iso ASC NULLS LAST LIMIT 100`,
    ).all(...params) as Record<string, unknown>[];
  } catch {
    return [];
  }

  return rows.map((r) => {
    const cegnev = String(r.cegnev ?? "");
    const eszkoz = String(r.eszkoz ?? "");
    const datum = String(r.datum_iso ?? "");
    const hiba = String(r.hibajelenseg ?? "");
    const munka = String(r.vegzett_munka ?? "");
    const dolgozo = String(r.dolgozo ?? "");
    const jSzam = String(r.j_szam ?? "");

    const custScore = seedCustomer && matchesCustomer(cegnev, seedCustomer) ? 0.4 : 0.2;
    const devScore = seedDevice && matchesMachine(eszkoz, seedDevice) ? 0.3 : 0.1;
    const dateScore = dateProximity(datum || null, seedDate, windowDays) * 0.3;
    const relevance = +(custScore + devScore + dateScore).toFixed(2);

    const snippetText = hiba || munka;
    const snippet = snippetText.length > 200 ? snippetText.slice(0, 197) + "..." : snippetText;

    return {
      source: "serviz_belso" as const,
      id: jSzam,
      date: datum || null,
      customer: cegnev || null,
      machine_type: eszkoz || null,
      fault: hiba || null,
      description: munka || null,
      person: dolgozo || null,
      snippet,
      relevance,
    };
  });
}

function searchSzevIgeny(
  dbs: OpenDbs,
  seedCustomer: string | null,
  seedDevice: string | null,
  seedDate: string | null,
  windowDays: number,
): TimelineEntry[] {
  if (!seedCustomer && !seedDevice) return [];

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (seedCustomer) {
    where.push("megrendelo_ascii LIKE ?");
    params.push(`%${fold(seedCustomer)}%`);
  }
  if (seedDevice) {
    where.push("geptipus LIKE ?");
    params.push(`%${seedDevice}%`);
  }
  if (seedDate) {
    const windowStart = new Date(Date.parse(seedDate) - windowDays * 86_400_000).toISOString().slice(0, 10);
    const windowEnd = new Date(Date.parse(seedDate) + windowDays * 86_400_000).toISOString().slice(0, 10);
    where.push("igeny_datum_iso >= ?");
    params.push(windowStart);
    where.push("igeny_datum_iso <= ?");
    params.push(windowEnd);
  }

  if (where.length === 0) return [];

  const whereSql = "WHERE " + where.join(" AND ");
  let rows: Record<string, unknown>[];
  try {
    rows = dbs.spec.query(
      `SELECT * FROM szev_igeny ${whereSql} ORDER BY igeny_datum_iso ASC NULLS LAST LIMIT 100`,
    ).all(...params) as Record<string, unknown>[];
  } catch {
    return [];
  }

  return rows.map((r) => {
    const megrendelo = String(r.megrendelo ?? "");
    const geptipus = String(r.geptipus ?? "");
    const igenyDatum = String(r.igeny_datum_iso ?? "");
    const igeny = String(r.igeny ?? "");
    const megjegyzes = String(r.megjegyzes ?? "");
    const felelos = String(r.felelos ?? "");
    const szevSzam = String(r.szev_szam ?? "");
    const statusz = r.statusz != null ? Number(r.statusz) : null;

    const custScore = seedCustomer && matchesCustomer(megrendelo, seedCustomer) ? 0.4 : 0.2;
    const devScore = seedDevice && matchesMachine(geptipus, seedDevice) ? 0.3 : 0.1;
    const dateScore = dateProximity(igenyDatum || null, seedDate, windowDays) * 0.3;
    const relevance = +(custScore + devScore + dateScore).toFixed(2);

    const snippetText = igeny || megjegyzes;
    const snippet = snippetText.length > 200 ? snippetText.slice(0, 197) + "..." : snippetText;

    return {
      source: "szev_igeny" as const,
      id: szevSzam,
      date: igenyDatum || null,
      customer: megrendelo || null,
      machine_type: geptipus || null,
      fault: null,
      description: igeny || null,
      person: felelos || null,
      snippet: snippet || (statusz != null ? `[statusz: ${statusz}]` : ""),
      relevance,
    };
  });
}

function searchTelephelyMunka(
  dbs: OpenDbs,
  seedCustomer: string | null,
  seedDevice: string | null,
  seedDate: string | null,
  windowDays: number,
): TimelineEntry[] {
  if (!seedCustomer && !seedDevice) return [];

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (seedCustomer) {
    where.push("megrendelo_ascii LIKE ?");
    params.push(`%${fold(seedCustomer)}%`);
  }
  if (seedDevice) {
    where.push("geptipus_ascii LIKE ?");
    params.push(`%${fold(seedDevice)}%`);
  }
  if (seedDate) {
    // telephely_munka has beerkezes_iso or kikuldes_iso
    const windowStart = new Date(Date.parse(seedDate) - windowDays * 86_400_000).toISOString().slice(0, 10);
    const windowEnd = new Date(Date.parse(seedDate) + windowDays * 86_400_000).toISOString().slice(0, 10);
    where.push("(beerkezes_iso >= ? OR kikuldes_iso >= ?)");
    params.push(windowStart, windowStart);
    where.push("(beerkezes_iso <= ? OR kikuldes_iso <= ?)");
    params.push(windowEnd, windowEnd);
  }

  if (where.length === 0) return [];

  const whereSql = "WHERE " + where.join(" AND ");
  let rows: Record<string, unknown>[];
  try {
    rows = dbs.spec.query(
      `SELECT * FROM telephely_munka ${whereSql} ORDER BY beerkezes_iso ASC NULLS LAST LIMIT 100`,
    ).all(...params) as Record<string, unknown>[];
  } catch {
    return [];
  }

  return rows.map((r) => {
    const megrendelo = String(r.megrendelo ?? "");
    const geptipus = String(r.geptipus ?? "");
    const datum = String(r.beerkezes_iso ?? r.kikuldes_iso ?? "");
    const hiba = String(r.hibajelenseg ?? "");
    const munka = String(r.elvegzett_munka ?? "");
    const sorszam = String(r.sorszam ?? "");

    const custScore = seedCustomer && matchesCustomer(megrendelo, seedCustomer) ? 0.4 : 0.2;
    const devScore = seedDevice && matchesMachine(geptipus, seedDevice) ? 0.3 : 0.1;
    const dateScore = dateProximity(datum || null, seedDate, windowDays) * 0.3;
    const relevance = +(custScore + devScore + dateScore).toFixed(2);

    const snippetText = hiba || munka;
    const snippet = snippetText.length > 200 ? snippetText.slice(0, 197) + "..." : snippetText;

    return {
      source: "telephely_munka" as const,
      id: sorszam || "?",
      date: datum || null,
      customer: megrendelo || null,
      machine_type: geptipus || null,
      fault: hiba || null,
      description: munka || null,
      person: null,
      snippet,
      relevance,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableExists(dbs: OpenDbs, name: string): boolean {
  try {
    const r = dbs.spec.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) as { 1?: number } | null;
    return !!r;
  } catch {
    return false;
  }
}
