// Ticket-linkage scanner (Phase 5b).
//
// Hungarian CMMS notes often contain explicit cross-references between
// tickets ("lásd B-2024/0891", "kapcsolódik K-2023/0455-höz"). The notes
// also have accidental digit sequences (telefonszám, dátum, firmware
// verzió) that look like sorszam candidates but are not.
//
// To be useful, the scanner needs to be strict: it must not invent links
// that don't exist. The strategy is two-stage:
//
//   1. Regex stage: pull candidate sorszam tokens from note bodies.
//      Patterns are intentionally conservative:
//
//        - [A-Z] followed by 4-digit year + "/" + 3-5 digits   ("B-2024/0891")
//        - [A-Z] followed by 2-digit YY + MM + 3-5 digits     ("B2408001")
//        - [A-Z] followed by optional "-" + 4-digit year
//                  + optional "/" + 3-5 digits                ("B 2024 0891")
//
//      Each match is normalized to its canonical form before lookup
//      (fold + strip spaces/hyphens, normalize "/" to "").
//
//   2. Catalog stage: each candidate is checked against the set of
//      known sorszam values built from the in-memory JobCache. Only
//      candidates that exactly match a real sorszam survive. This is
//      the precision guarantee: a regex match on a phone number or
//      firmware version will almost never correspond to a real ticket
//      sorszam, so it gets dropped here.
//
// The output is a bidirectional index:
//
//   - forward[sorszam]  = list of notes that reference this sorszam
//                         (i.e. the referenced ticket)
//   - reverse[sorszam]  = list of tickets that this sorszam references
//                         (i.e. the referencing ticket)
//
// "Note" here is the (source_sorszam, kind, snippet) tuple — enough for
// the LLM to cite the actual mention without returning the whole note.

import type { JobCache, JobCard, Note } from "../cache/jobs";

export type LinkageRef = {
  /** Sorszam that contains the mention. */
  from: string;
  /** Sorszam being referenced. */
  to: string;
  /** Note kind where the mention was found. */
  kind: Note["kind"];
  /** Short context snippet (the surrounding text). */
  snippet: string;
};

export type LinkageIndex = {
  /** to -> list of refs that point at it. */
  forward: Map<string, LinkageRef[]>;
  /** from -> list of refs it makes. */
  reverse: Map<string, LinkageRef[]>;
  /** Total number of refs. */
  total: number;
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Fold diacritics + lowercase. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Strip spaces, hyphens, slashes. Used to collapse variant forms. */
function squash(s: string): string {
  return fold(s).replace(/[\s\-\/]/g, "");
}

/** Trim a known sorszam to its canonical form. The cache stores the
 *  raw sorszam (with whatever separators the source had). We keep
 *  that as the canonical form, and only use the squashed form for
 *  matching candidates. */
function canonical(s: string): string {
  return s.trim();
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Each pattern returns the matched substring; we then squash + validate
 * against the known catalog. Patterns are tried in order; the first
 * that matches a known sorszam wins.
 */
const SORSZAM_PATTERNS: RegExp[] = [
  // "B-2024/0891", "B 2024/0891", "B2024/0891", "B-2024/891"
  /\b[A-Z][-\s]?\d{4}\/\d{3,5}\b/gi,
  // "B2408001" (compact: letter + 2YY + 2MM + 3-5 seq)
  /\b[A-Z]\d{6,9}\b/g,
  // "B-20240891" (letter + hyphen + 4YY + 2MM + 3-5 seq, no slash)
  /\b[A-Z]-\d{7,9}\b/gi,
];

// ---------------------------------------------------------------------------
// Index build
// ---------------------------------------------------------------------------

/**
 * Build a bidirectional linkage index by scanning all note bodies in
 * the cache for sorszam references.
 *
 * Cost: O(tickets * avg_notes * pattern_cost). For 65K tickets this
 * is fast (~200-500ms on the production server) but should not block
 * the event loop, so the caller should run it during startup, not on
 * the first request.
 */
export function buildLinkageIndex(cache: JobCache): LinkageIndex {
  // Catalog: squashed sorszam -> canonical sorszam.
  const catalog = new Map<string, string>();
  for (const card of cache.allJobs()) {
    const s = canonical(card.sorszam);
    if (!s) continue;
    catalog.set(squash(s), s);
  }

  const forward = new Map<string, LinkageRef[]>();
  const reverse = new Map<string, LinkageRef[]>();
  let total = 0;

  for (const card of cache.allJobs()) {
    const fromSorszam = canonical(card.sorszam);
    if (!fromSorszam) continue;

    for (const note of card.notes) {
      const body = note.body ?? "";
      if (!body) continue;

      const found = extractRefs(body, catalog, fromSorszam);
      if (found.length === 0) continue;

      // Dedupe (a note might mention the same ticket multiple times).
      const seenInNote = new Set<string>();
      for (const toSorszam of found) {
        if (toSorszam === fromSorszam) continue; // ignore self-refs
        const key = `${fromSorszam}->${toSorszam}`;
        if (seenInNote.has(key)) continue;
        seenInNote.add(key);

        const ref: LinkageRef = {
          from: fromSorszam,
          to: toSorszam,
          kind: note.kind,
          snippet: extractSnippet(body, toSorszam),
        };
        pushTo(forward, toSorszam, ref);
        pushTo(reverse, fromSorszam, ref);
        total++;
      }
    }
  }

  return { forward, reverse, total };
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** All tickets that reference the given sorszam. */
export function referencedBy(idx: LinkageIndex, sorszam: string): LinkageRef[] {
  return idx.forward.get(sorszam)
    ? (idx.forward.get(sorszam) as LinkageRef[]).slice()
    : [];
}

/** All sorszams that the given ticket references. */
export function referencesOf(idx: LinkageIndex, sorszam: string): LinkageRef[] {
  return idx.reverse.get(sorszam)
    ? (idx.reverse.get(sorszam) as LinkageRef[]).slice()
    : [];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Run all patterns over `body` and return canonical sorszam matches. */
function extractRefs(body: string, catalog: Map<string, string>, fromSorszam: string): string[] {
  const out = new Set<string>();
  for (const pat of SORSZAM_PATTERNS) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(body)) !== null) {
      const candidate = m[0];
      const sq = squash(candidate);
      const canon = catalog.get(sq);
      if (canon) out.add(canon);
    }
  }
  return Array.from(out);
}

function pushTo(map: Map<string, LinkageRef[]>, key: string, ref: LinkageRef): void {
  const sq = squash(key);
  // We don't squash the key storage; we just look up by the canonical
  // form passed in. (extractRefs already returns canonicals.)
  const arr = map.get(key) ?? [];
  arr.push(ref);
  map.set(key, arr);
}

/** Pull a 200-char window around the matched sorszam in the body. */
function extractSnippet(body: string, sorszam: string): string {
  // Find the first occurrence of sorszam (case-insensitive) for context.
  const idx = body.toLowerCase().indexOf(sorszam.toLowerCase());
  if (idx < 0) {
    // Fallback: first 200 chars of the body.
    return body.length > 200 ? body.slice(0, 197) + "..." : body;
  }
  const start = Math.max(0, idx - 80);
  const end = Math.min(body.length, idx + sorszam.length + 120);
  const win = body.slice(start, end);
  return win.length > 200 ? win.slice(0, 197) + "..." : win;
}
