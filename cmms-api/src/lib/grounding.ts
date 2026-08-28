// src/lib/grounding.ts
//
// Grounding gate for the pure-RAG LLM rephrase.
//
// The LLM is told to answer using ONLY the retrieved chunks. We
// verify that claim by scanning the LLM output for three classes
// of "citable" facts:
//
//   1. Sorszams (B-prefix, M-prefix machine serials) — must appear
//      in the retrieved set OR the question itself.
//   2. Customer names (multi-token Title Case + legal-suffix hint) —
//      must token-overlap with a customer in the retrieved set.
//   3. Dates (ISO, dotted, Hungarian "2024. május 10.") — must be
//      the date of a retrieved ticket or the current period.
//
// If any cited fact fails, the LLM output is rejected and the
// caller falls back to the deterministic summary. We never
// 500 on grounding failure.
//
// This is the post-rebuild version: it takes a `ground` object
// rather than the old RoutePlan/ExecResult/JobCard types. The
// old deterministic engine is gone; the only source of truth is
// the chunk set the retriever returned.

export type RagGround = {
  /** Sorszams (canonical: B2408001) found in the retrieved chunks + the question. */
  sorszams: Set<string>;
  /** Customer names (verbatim, as they appear in the chunks). */
  customerPhrases: string[];
  /** Folded customer tokens, for token-coverage check. */
  customerTokens: Set<string>;
  /** Reported dates (YYYY-MM-DD) from the retrieved chunks. */
  dates: Set<string>;
};

export type RagGroundingVerdict = {
  ok: boolean;
  rejected_facts: Array<{ kind: "sorszam" | "customer" | "date"; value: string; reason: string }>;
  scanned: { sorszams: number; customers: number; dates: number };
};

// ---------------------------------------------------------------------------
// Hungarian fold
// ---------------------------------------------------------------------------
function fold(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function foldTokens(s: string): string[] {
  return fold(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}
function canonSorszam(s: string): string {
  return s.toUpperCase().replace(/[-\s]/g, "");
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------
function extractSorszams(text: string): string[] {
  const out = new Set<string>();
  const reWb = /\bB-?\d{4}-?\d{3,5}\b|\bB\d{7,9}\b/g;
  for (const m of text.matchAll(reWb)) out.add(canonSorszam(m[0]));
  const reM = /\bM\d{4,7}\b/g;
  for (const m of text.matchAll(reM)) out.add(m[0].toUpperCase());
  return [...out];
}

const CUSTOMER_HINT_WORDS = [
  "kft", "zrt", "bt", "nyrt", "kkt", "gmbh", "llc", "ltd",
  "sro", "s.r.o", "spol", "s.p.a", "s.a", "co", "plc", "nv", "bv",
  "ag", "inc", "hold", "group", "gep", "gepar", "gyar", "holding",
  "ipar", "machine", "machines", "tools", "tech",
];

function extractCustomerMentions(text: string): string[] {
  const out: string[] = [];
  for (const s of text.split(/[.!?\n]+/)) {
    const re = /\b([A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]+(?:\s+[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]+){1,5})\b/g;
    for (const m of s.matchAll(re)) {
      const phrase = m[0].trim();
      const folded = fold(phrase);
      if (folded.length < 8) continue;
      const tokens = folded.split(/\s+/);
      if (!tokens.some((t) => CUSTOMER_HINT_WORDS.includes(t))) continue;
      if (/^(sajat|legutobbi|legnagyobb|kovetkezo|a leg)/i.test(folded)) continue;
      out.push(phrase);
    }
  }
  return [...new Set(out)];
}

const HU_MONTHS: Record<string, string> = {
  januar: "01", februar: "02", marcius: "03", aprilis: "04",
  majus: "05", junius: "06", julius: "07", augusztus: "08",
  szeptember: "09", oktober: "10", november: "11", december: "12",
};
function extractDates(text: string): string[] {
  const out = new Set<string>();
  // ISO
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    out.add(`${m[1]}-${m[2]}-${m[3]}`);
  }
  // Dotted Hungarian: 2024.05.10
  for (const m of text.matchAll(/\b(\d{4})\.(\d{1,2})\.(\d{1,2})\b/g)) {
    out.add(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  }
  // Hungarian month name: 2024. május 10.
  for (const m of text.matchAll(/\b(\d{4})\.\s*([a-záéíóöőúüű]+)\s+(\d{1,2})\./gi)) {
    const mon = HU_MONTHS[fold(m[2])];
    if (mon) out.add(`${m[1]}-${mon}-${m[3].padStart(2, "0")}`);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Build a RagGround from a set of retrieved RagHits + the question
// ---------------------------------------------------------------------------
import type { RagHit } from "./rag";

export function buildRagGround(hits: RagHit[], question: string): RagGround {
  const sorszams = new Set<string>();
  const customerPhrases: string[] = [];
  const customerTokens = new Set<string>();
  const dates = new Set<string>();

  for (const h of hits) {
    sorszams.add(canonSorszam(h.sorszam));
    if (h.customer) {
      customerPhrases.push(h.customer);
      for (const t of foldTokens(h.customer)) customerTokens.add(t);
    }
    if (h.device) {
      // The device code is also a citable fact; add its components
      // as sorszams so the LLM can mention "TMV" or "NCT-99".
      for (const part of h.device.split(/[\s/]+/)) {
        if (part.length >= 3) sorszams.add(part.toUpperCase());
      }
    }
    if (h.reported_at_iso) dates.add(h.reported_at_iso.slice(0, 10));
  }

  // The question itself is also a source of truth (the user can
  // mention a sorszam they have in hand and the LLM can echo it).
  for (const s of extractSorszams(question)) sorszams.add(canonSorszam(s));
  for (const c of extractCustomerMentions(question)) {
    customerPhrases.push(c);
    for (const t of foldTokens(c)) customerTokens.add(t);
  }
  for (const d of extractDates(question)) dates.add(d);

  return { sorszams, customerPhrases, customerTokens, dates };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function enforceGrounding(
  llmText: string,
  hits: RagHit[],
  fallbackSummary: string,
): RagGroundingVerdict {
  const ground = buildRagGround(hits, "");

  // The deterministic fallback is also a source of truth (it was
  // built from the same hits, so the LLM can echo it).
  for (const s of extractSorszams(fallbackSummary)) ground.sorszams.add(canonSorszam(s));
  for (const c of extractCustomerMentions(fallbackSummary)) {
    for (const t of foldTokens(c)) ground.customerTokens.add(t);
  }
  for (const d of extractDates(fallbackSummary)) ground.dates.add(d);

  const rejected: RagGroundingVerdict["rejected_facts"] = [];

  // 1) Sorszams.
  const llmSorszams = extractSorszams(llmText);
  for (const s of llmSorszams) {
    if (!ground.sorszams.has(s)) {
      rejected.push({
        kind: "sorszam",
        value: s,
        reason: `sorszam not in retrieved chunks (ground has ${ground.sorszams.size} sorszams)`,
      });
    }
  }

  // 2) Customer names.
  const llmCustomers = extractCustomerMentions(llmText);
  for (const c of llmCustomers) {
    const tokens = foldTokens(c);
    if (tokens.length === 0) continue;
    const overlap = tokens.filter((t) => ground.customerTokens.has(t)).length;
    const coverage = overlap / tokens.length;
    if (coverage < 0.6) {
      rejected.push({
        kind: "customer",
        value: c,
        reason: `customer token coverage ${(coverage * 100).toFixed(0)}% < 60%`,
      });
    }
  }

  // 3) Dates.
  const llmDates = extractDates(llmText);
  for (const d of llmDates) {
    if (!ground.dates.has(d)) {
      rejected.push({
        kind: "date",
        value: d,
        reason: `date not in any retrieved ticket or fallback (ground has ${ground.dates.size} dates)`,
      });
    }
  }

  return {
    ok: rejected.length === 0,
    rejected_facts: rejected,
    scanned: {
      sorszams: llmSorszams.length,
      customers: llmCustomers.length,
      dates: llmDates.length,
    },
  };
}

// ---------------------------------------------------------------------------
// deterministicIsShort — used to decide whether to skip the LLM.
// (A short deterministic summary is already perfect; rewriting it
// with the LLM can only introduce grounding risk.)
// ---------------------------------------------------------------------------
export function deterministicIsShort(s: string): boolean {
  return s.length < 80;
}
