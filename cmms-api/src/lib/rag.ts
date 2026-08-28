// src/lib/rag.ts
//
// Pure-RAG retrieval over the cmms.db + cmms_specialized.db data.
// No deterministic router, no classifier, no structured primitives.
// One job: take a question, return the top-K most relevant ticket
// chunks, hand them to the LLM, and let the LLM answer.
//
// Storage strategy
// ----------------
// We materialize an FTS5 virtual table over the joined view of
// jobs + customers + devices + notes. The view is rebuilt from
// cmms_specialized.db on:
//
//   1. initial build (at startup)
//   2. every ETL run that loaded new rows
//   3. (never on every query — too slow on 65K rows)
//
// We trade freshness for speed: after the human CMMS app appends
// a new ticket, the watcher waits ~1s, runs the incremental ETL,
// and rebuilds the index. New questions see the new ticket within
// ~2s.
//
// Schema
// ------
//   FTS5 columns:
//     sorszam     -- B2408001 / B-2024/1234
//     customer    -- "ANDRITZ KFT."  (folded-ascii copy also indexed)
//     device      -- "TMV-4 / NCT-99"
//     kind        -- reported | work | free
//     body        -- the actual text the technician wrote
//   Side table:  chunk_meta(sorszam, kind, body, customer, device,
//                            reported_at_iso, kategoria, status)
//                -- we join back to this for the answer payload.
//
// Why a side table, not just FTS5
// -------------------------------
// FTS5 stores the index but not the original text or the structured
// fields. We need the original Hungarian text and the dates for
// grounding. So we keep `chunk_meta` populated alongside.
//
// Tokenization
// ------------
// We use the default unicode61 tokenizer with `tokenchars='_āáéíóöőúüű'`
// to keep Hungarian diacritics. NOT perfect stemmer, but the dev data
// is mixed-language technical Hungarian and a stemmer over-cuts
// ("esztergályos" -> "esztergaly", losing recall). unicode61 + the
// body's _ascii fold (in cmms_specialized.db) is good enough.

import type { Database } from "bun:sqlite";
import type { OpenDbs } from "../db/open";
import { fold } from "../db/parse";

export type RagChunk = {
  sorszam: string;
  kind: "reported" | "work" | "free";
  body: string;
  customer: string | null;
  device: string | null;
  reported_at_iso: string | null;
  kategoria: string | null;
  status: 0 | 1; // 0=closed, 1=open
  score: number;
};

export type RagHit = {
  sorszam: string;
  customer: string | null;
  device: string | null;
  reported_at_iso: string | null;
  kategoria: string | null;
  status: 0 | 1;
  top_chunks: Array<{ kind: string; body: string; score: number }>;
  total_score: number;
};

export type RagIndex = {
  size(): number;
  buildMs: number;
};

// ---------------------------------------------------------------------------
// Build / rebuild
// ---------------------------------------------------------------------------

export function buildRagIndex(dbs: OpenDbs): RagIndex {
  const t0 = Date.now();
  // Drop and recreate. We rebuild from scratch because the cmms.db
  // mtime is the cheap "needs rebuild" signal and the rebuild is
  // < 10s on 65K rows.
  ensureFtsTables(dbs.spec);
  rebuildRagIndex(dbs, indexHandle(dbs));
  return { size: () => countChunks(dbs.spec), buildMs: Date.now() - t0 };
}

/**
 * Rebuild only when needed: ETL loaded rows (force) or the FTS
 * tables are empty (first run / deleted side DB). On a no-change
 * restart this reuses the existing index and returns in ~1ms, which
 * keeps systemd restarts fast enough for the watchdog.
 */
export function ensureRagIndex(dbs: OpenDbs, force: boolean): RagIndex {
  const t0 = Date.now();
  ensureFtsTables(dbs.spec);
  const existing = countChunks(dbs.spec);
  if (!force && existing > 0) {
    return { size: () => countChunks(dbs.spec), buildMs: 0 };
  }
  rebuildRagIndex(dbs, indexHandle(dbs));
  return { size: () => countChunks(dbs.spec), buildMs: Date.now() - t0 };
}

export function rebuildRagIndex(dbs: OpenDbs, _idx: RagIndex): void {
  const spec = dbs.spec;
  spec.exec("DELETE FROM rag_chunk_meta;");
  spec.exec("DELETE FROM rag_chunks;");

  // Pull every (job, note) pair joined with customer + device info.
  // We stream in batches so 65K rows don't peak memory.
  const stmt = spec.prepare(`
    SELECT
      j.sorszam               AS sorszam,
      n.kind                  AS kind,
      n.body                  AS body,
      c.name                  AS customer,
      (
        SELECT d.raw_type
        FROM devices d
        WHERE d.job_key = j.key
        ORDER BY d.id ASC
        LIMIT 1
      )                       AS device,
      j.reported_at_iso       AS reported_at_iso,
      j.problem_kategoria     AS kategoria,
      j.status                AS status
    FROM jobs j
    INNER JOIN notes n ON n.job_key = j.key
    LEFT JOIN customers c ON c.id = j.customer_id
    WHERE n.body IS NOT NULL AND length(trim(n.body)) > 0
  `);
  const insertMeta = spec.prepare(`
    INSERT INTO rag_chunk_meta
      (sorszam, kind, body, customer, device, reported_at_iso, kategoria, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Explicit rowid = the rag_chunk_meta id, so the FTS↔meta join in
  // ragSearch is exact regardless of insert order or partial deletes.
  const insertFts = spec.prepare(`
    INSERT INTO rag_chunks (rowid, sorszam, customer, device, kind, body, body_ascii)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = spec.transaction(
    (rows: Array<{
      sorszam: string;
      kind: string;
      body: string;
      customer: string | null;
      device: string | null;
      reported_at_iso: string | null;
      kategoria: string | null;
      status: number;
    }>) => {
      for (const r of rows) {
        const metaRes = insertMeta.run(
          r.sorszam,
          r.kind,
          r.body,
          r.customer,
          r.device,
          r.reported_at_iso,
          r.kategoria,
          r.status,
        );
        insertFts.run(
          Number(metaRes.lastInsertRowid),
          r.sorszam,
          r.customer ?? "",
          r.device ?? "",
          r.kind,
          r.body,
          fold(r.body),
        );
      }
    },
  );

  let batch: any[] = [];
  const BATCH = 1000;
  for (const row of stmt.iterate() as Iterable<any>) {
    batch.push(row);
    if (batch.length >= BATCH) {
      insertAll(batch);
      batch = [];
    }
  }
  if (batch.length > 0) insertAll(batch);
}

function indexHandle(_dbs: OpenDbs): RagIndex {
  // The index "handle" is just a small wrapper so the call sites in
  // index.ts can hold something. All real data lives in the FTS
  // table + chunk_meta side table; we read through the DB each time.
  return { size: () => 0, buildMs: 0 };
}

function countChunks(spec: Database): number {
  const r = spec.query("SELECT COUNT(*) AS n FROM rag_chunk_meta").get() as { n: number };
  return r.n;
}

function ensureFtsTables(spec: Database): void {
  // FTS5 virtual table with an external-content trick is overkill;
  // we just store the body twice (once in rag_chunks for FTS, once in
  // rag_chunk_meta for the structured payload). Total cost on 65K
  // notes ≈ 50MB extra disk, which is fine.
  spec.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks USING fts5(
      sorszam,
      customer,
      device,
      kind,
      body,
      body_ascii,
      tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
    );
  `);
  spec.exec(`
    CREATE TABLE IF NOT EXISTS rag_chunk_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sorszam TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      customer TEXT,
      device TEXT,
      reported_at_iso TEXT,
      kategoria TEXT,
      status INTEGER NOT NULL
    );
  `);
  spec.exec(`CREATE INDEX IF NOT EXISTS idx_rag_meta_sorszam ON rag_chunk_meta(sorszam);`);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Retrieve the top-K most relevant chunks for a Hungarian / English
 * question. The query is matched against `body`, `body_ascii`,
 * `customer`, `device`, and `sorszam` so a question like
 *
 *   "mi volt a B2408001 hiba?"
 *
 * pulls the right ticket even though the sorszam itself isn't in
 * the body. We use BM25 (the default) — no embedding model, no
 * external dep, ~0 RAM, ~50ms on 65K rows.
 */
export function ragSearch(
  dbs: OpenDbs,
  query: string,
  opts: { limit?: number; kindFilter?: Array<"reported" | "work" | "free"> } = {},
): RagChunk[] {
  const limit = opts.limit ?? 20;
  // Build a safe FTS5 prefix query. We split on whitespace, drop
  // stopwords, and OR each token as `term*` so prefix-match works
  // ("szerviz" matches "szervizben" too).
  const tokens = sanitizeFtsQuery(query);
  if (tokens.length === 0) return [];

  const ftsQuery = tokens.map((t) => `${t}*`).join(" OR ");

  // We join back to rag_chunk_meta via rowid to get the structured
  // fields (date, kategoria, status) that the FTS5 virtual table
  // doesn't carry. rowid is the natural key FTS5 maintains.
  const rows = dbs.spec
    .prepare(
      `
      SELECT
        m.sorszam, m.kind, m.body,
        m.customer, m.device, m.reported_at_iso, m.kategoria, m.status,
        bm25(rag_chunks) AS score
      FROM rag_chunks
      INNER JOIN rag_chunk_meta m ON m.id = rag_chunks.rowid
      WHERE rag_chunks MATCH ?
      ORDER BY score ASC
      LIMIT ?
      `,
    )
    .all(ftsQuery, limit) as Array<{
    sorszam: string;
    kind: string;
    body: string;
    customer: string | null;
    device: string | null;
    reported_at_iso: string | null;
    kategoria: string | null;
    status: number;
    score: number;
  }>;

  // Filter by kind after retrieval (the FTS index itself doesn't
  // carry a kind constraint, and the bm25 ORDER BY needs to be
  // computed across all kinds to be useful).
  const filtered = opts.kindFilter
    ? rows.filter((r) => opts.kindFilter!.includes(r.kind as any))
    : rows;

  return filtered.map((r) => ({
    sorszam: r.sorszam,
    kind: r.kind as "reported" | "work" | "free",
    body: r.body,
    customer: r.customer,
    device: r.device,
    reported_at_iso: r.reported_at_iso,
    kategoria: r.kategoria,
    status: r.status as 0 | 1,
    score: r.score,
  }));
}

/**
 * Group chunks by sorszam so the LLM sees one row per ticket with
 * the top 2-3 matching chunks. This is what we hand the model.
 */
export function groupHits(chunks: RagChunk[]): RagHit[] {
  const bySorszam = new Map<string, RagHit>();
  for (const c of chunks) {
    let hit = bySorszam.get(c.sorszam);
    if (!hit) {
      hit = {
        sorszam: c.sorszam,
        customer: c.customer,
        device: c.device,
        reported_at_iso: c.reported_at_iso,
        kategoria: c.kategoria,
        status: c.status,
        top_chunks: [],
        total_score: 0,
      };
      bySorszam.set(c.sorszam, hit);
    }
    hit.top_chunks.push({ kind: c.kind, body: c.body, score: c.score });
    hit.total_score += c.score;
  }
  // Keep top 3 chunks per ticket, drop the rest.
  for (const h of bySorszam.values()) {
    h.top_chunks.sort((a, b) => a.score - b.score);
    h.top_chunks = h.top_chunks.slice(0, 3);
  }
  // Rank tickets by total_score ASC (lower BM25 = better).
  return [...bySorszam.values()].sort((a, b) => a.total_score - b.total_score);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// FTS5 reserves a handful of characters. We strip them so a user
// question like "miért nem működik a B2408001?" doesn't blow up the
// MATCH parser. We also lowercase + fold, then drop noise tokens.
const FTS_STRIP = /[\^"'\(\)\[\]\{\}\~\*\:\+\-]/g;
const HUNGARIAN_STOPWORDS = new Set([
  "a", "az", "és", "hogy", "is", "egy", "egyik", "másik", "mely",
  "melyik", "mikor", "mert", "de", "vagy", "ha", "ha", "már", "még",
  "the", "and", "for", "with", "what", "when", "was", "were", "this",
  "that", "from", "into", "have", "has", "had",
]);

function sanitizeFtsQuery(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[áéíóöőúüű]/g, (m) =>
      m === "á" ? "a"
        : m === "é" ? "e"
        : m === "í" ? "i"
        : m === "ó" ? "o"
        : m === "ö" ? "o"
        : m === "ő" ? "o"
        : m === "ú" ? "u"
        : m === "ü" ? "u"
        : m === "ű" ? "u"
        : m,
    )
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !HUNGARIAN_STOPWORDS.has(t));
}
