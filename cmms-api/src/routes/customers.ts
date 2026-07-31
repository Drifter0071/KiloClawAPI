// Customer search + canonical-name grouping (Phase 2).
//
// The cmms_specialized.db has 65 921 distinct customer name strings in
// the jobs.customer_id -> customers.name join. Many of those are
// spelling variants of the same real company ("ANDRITZ Kft." / "ANDRITZ
// Hungary Kft." / "Andritz AG" / "ANDRITZ Járműipari ..."). The LLM
// needs a way to ask "are these the same customer?" without listing
// every spelling variant every time.
//
// We don't precompute a canonical table (that would be R7's
// build_customer_canonicals.ts backfill). For Phase 2 we do a fast
// in-memory fold on demand: normalize each customer name by stripping
// legal-entity suffixes (Kft, Zrt, Bt, Kkt, Nyrt, etc.), lowercasing,
// diacritic-folding, and removing punctuation. Then group by the
// normalized key. The result is a set of canonical groups with their
// aliases and ticket counts.
//
// All endpoints are read-only and require the read token.

import express from "express";
import type { SQLQueryBindings } from "bun:sqlite";
import type { OpenDbs } from "../db/open";

// Hungarian legal-entity suffixes + foreign ones we see in practice.
const SUFFIX_PATTERNS = [
  /\bkft\.?\b/gi,
  /\bzrt\.?\b/gi,
  /\bnyrt\.?\b/gi,
  /\bbt\.?\b/gi,
  /\bkkt\.?\b/gi,
  /\bév\.?\b/gi,
  /\bévf\.?\b/gi,
  /\bag\b/gi,
  /\bgmbh\b/gi,
  /\bllc\b/gi,
  /\binc\.?\b/gi,
  /\bltd\.?\b/gi,
  /\bs\.?r\.?o\.?\b/gi,
  /\bspol\.?\b/gi,
  /\bsro\b/gi,
  /\bs\.p\.?a\.?\b/gi,
  /\bs\.a\.?\b/gi,
  /\bco\.?\b/gi,
  /\bplc\b/gi,
  /\bnv\b/gi,
  /\bbv\b/gi,
  // Hungarian location tokens that show up at the end
  /\b(rt|rt\.)\b/gi,
];

// Stop words inside customer names that are noisy for grouping.
const STOP_WORDS = [
  "magyarorszag", "magyarorszagi", "hungary", "hungarian",
  "ipari", "kereskedelmi", "es", "es szolgaltato", "szolgaltato",
  "vallalat", "uzem", "gyar", "uzemegyseg",
];

function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function normalizeCustomerName(raw: string): string {
  let s = foldAccents(raw);
  for (const p of SUFFIX_PATTERNS) s = s.replace(p, " ");
  s = s.replace(/[^a-z0-9 ]+/g, " "); // punctuation to space
  s = s.replace(/\s+/g, " ").trim();
  for (const w of STOP_WORDS) {
    s = s.replace(new RegExp(`\\b${w}\\b`, "g"), "");
  }
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function customersRouter(dbs: OpenDbs): express.Router {
  const r = express.Router();

  // GET /v1/customers/search?q=ANDRITZ&limit=20
  // Substring match on customer name (diacritic-folded), with a per-customer
  // ticket count. Most useful for the LLM to disambiguate spelling variants.
  r.get("/v1/customers/search", (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    const limit = Math.min(Number(req.query.limit ?? 20), 200);
    if (!q || q.length < 1) {
      res.status(400).json({ error: { code: "bad_request", message: "missing q" } });
      return;
    }
    const like = `%${foldAccents(q)}%`;
    const rows = dbs.spec.query(
      `SELECT c.id, c.name, c.name_ascii, c.zip, c.address, c.phone, c.email,
              (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) AS ticket_count,
              (SELECT MAX(j.reported_at_iso) FROM jobs j WHERE j.customer_id = c.id) AS last_seen
       FROM customers c
       WHERE c.name_ascii LIKE ?
       ORDER BY ticket_count DESC
       LIMIT ?`,
    ).all(like, limit) as {
      id: number; name: string; name_ascii: string; zip: string | null;
      address: string | null; phone: string | null; email: string | null;
      ticket_count: number; last_seen: string | null;
    }[];
    res.json({ total: rows.length, q, customers: rows });
  });

  // POST /v1/customers/canonical
  //   { q?: string, limit?: number, min_tickets?: number }
  // Groups customers by normalized-name key. Returns canonical groups
  // sorted by total ticket count. Each group contains its aliases (the
  // raw customer names that folded to the same key) and per-alias counts.
  //
  // If q is given, we only canonicalize customers whose name matches
  // (folded) LIKE %q%. Otherwise we canonicalize ALL ~3k customers —
  // still fast because we only do the fold in memory on the already-
  // loaded customer rows.
  r.post("/v1/customers/canonical", (req, res) => {
    const b = (req.body ?? {}) as { q?: string; limit?: number; min_tickets?: number };
    const limit = Math.min(Number(b.limit ?? 20), 100);
    const minTickets = Number(b.min_tickets ?? 1);
    const q = b.q?.trim();

    // Pull all candidate customers + a per-customer ticket count.
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (q) { where.push("c.name_ascii LIKE ?"); params.push(`%${foldAccents(q)}%`); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const rows = dbs.spec.query(
      `SELECT c.id, c.name,
              (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) AS ticket_count
       FROM customers c
       ${whereSql}`,
    ).all(...params) as { id: number; name: string; ticket_count: number }[];

    // Group by normalized name. Within a group, the canonical name is
    // the LONGEST raw name (more likely to be the official form).
    type Group = { canonical: string; canonical_id: number; total: number; aliases: { name: string; id: number; ticket_count: number }[] };
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const key = normalizeCustomerName(r.name);
      if (!key) continue;
      const g = groups.get(key) ?? { canonical: r.name, canonical_id: r.id, total: 0, aliases: [] };
      g.aliases.push({ name: r.name, id: r.id, ticket_count: r.ticket_count });
      g.total += r.ticket_count;
      if (r.name.length > g.canonical.length) {
        g.canonical = r.name;
        g.canonical_id = r.id;
      }
      groups.set(key, g);
    }

    const out = [...groups.values()]
      .filter((g) => g.total >= minTickets)
      .map((g) => ({
        canonical: g.canonical,
        canonical_id: g.canonical_id,
        normalized_key: normalizeCustomerName(g.canonical),
        total_tickets: g.total,
        alias_count: g.aliases.length,
        aliases: g.aliases
          .sort((a, b) => b.ticket_count - a.ticket_count)
          .map((a) => ({ id: a.id, name: a.name, ticket_count: a.ticket_count })),
      }))
      .sort((a, b) => b.total_tickets - a.total_tickets)
      .slice(0, limit);

    res.json({ total: out.length, q: q ?? null, min_tickets: minTickets, groups: out });
  });

  return r;
}
