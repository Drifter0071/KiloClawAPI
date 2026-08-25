// /v1/answer — the Phase 1 router endpoint.
//
// Accepts a free-text question (hu/en), runs it through the
// keyword-based router, executes the resulting plan against the
// cache, and returns a structured answer with evidence. The LLM
// mostly just relays the `summary` field to the user; the model
// never has to pick a tool itself.
//
// This is the single biggest consistency win of Phase 1: same
// question in -> same plan -> same answer, every session.

import type { Router } from "express";
import { Router as makeRouter } from "express";
import type { JobCache } from "../cache/jobs";
import type { OpenDbs } from "../db/open";
import { resolvePeriod } from "../lib/period";
import { routeQuestion, contextualizeFollowUps, type RoutePlan } from "../lib/router";
import { stripHaystack } from "./shared";
import { findRelated } from "../lib/related";
import { stripLLMDates } from "../lib/date_guard";
import { expandPlan, rankCandidates, DEFAULT_THRESHOLD, type CandidateScore } from "../lib/score";
import { detectAttr, extractAttr, attrSentence, cardSource } from "../lib/answer_text";
import { huThe, huCite, huDefiniteArticle } from "../lib/hu";
import { llmConfigured, renderLlmAnswer } from "../lib/llm";
import { insertFeedbackAnswer } from "./feedback";
import { fold as foldAccents } from "../lib/related";

// Crockford-base32 ULID (same shape as lib/agent.ts). Inlined here so
// the legacy /v1/answer endpoint can stamp feedback_answers rows
// without depending on the agent runtime. 26 chars, URL-safe.
const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function newUlid(): string {
  const now = Date.now();
  let ts = now;
  let tsPart = "";
  for (let i = 9; i >= 0; i -= 1) {
    tsPart = ULID_ALPHABET[ts % 32] + tsPart;
    ts = Math.floor(ts / 32);
  }
  let randPart = "";
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 16; i += 1) {
    const byte = bytes[i] ?? 0;
    randPart += ULID_ALPHABET[byte % 32];
  }
  return tsPart + randPart;
}

type AnswerBody = {
  q: string;
  language?: "hu" | "en";
  // The model can override router decisions with explicit filters.
  customer?: string;
  device?: string;
  kategoria?: string;
  kategoria_inferred?: string;
  sulyossag_inferred?: string;
  period?: string;
  status?: "open" | "closed";
  limit?: number;
  /** Render-only LLM rewrite of `summary` (Kilo Gateway, UI toggle). */
  llm?: boolean;
};

type EvidenceTicket = {
  sorszam: string;
  key: number;
  reported_at_iso: string | null;
  snippet: string;
  kategoria: string | null;
  kategoria_inferred: string | null;
  sulyossag_inferred: string | null;
};

export function answerRouter(cache: JobCache, dbs: OpenDbs): Router {
  const r = makeRouter();

  r.post("/v1/answer", async (req, res) => {
    const body = (req.body ?? {}) as AnswerBody;
    const q = (body.q ?? "").trim();
    if (!q) {
      res.status(400).json({ error: { code: "missing_q", message: "q (the question) is required" } });
      return;
    }
    const language: "hu" | "en" = body.language === "en" ? "en" : "hu";

    // 1) Route the question to a plan.
    const plan = routeQuestion(q, language);

    // 2) Apply caller-supplied overrides.
    if (body.customer) plan.filters.customer = body.customer;
    if (body.device) plan.filters.device = body.device;
    if (body.kategoria) plan.filters.kategoria = body.kategoria;
    if (body.kategoria_inferred) plan.filters.kategoria_inferred = body.kategoria_inferred;
    if (body.sulyossag_inferred) plan.filters.sulyossag_inferred = body.sulyossag_inferred;
    if (body.status) plan.filters.status = body.status;
    if (body.period) plan.period = body.period;
    if (body.limit) plan.limit = body.limit;

    // Phase 6: weak-customer probe. The router's `extractWeakCustomer`
    // is intentionally permissive (1-3 token ALL-CAPS phrases with no
    // legal suffix) so the user can ask about a company without
    // remembering its exact legal form ("SVG HDMC" instead of
    // "SVG-HUNGARY GÉPGYÁR ZRT."). Before honoring the filter we
    // probe the customers table; if 0 customers match, the weak
    // signal is discarded and the question falls through to whatever
    // branch would have fired without it.
    if (plan.weak_customer) {
      const probe = probeCustomer(dbs, plan.weak_customer);
      if (probe) {
        // Promote the weak signal: use the canonical (longest) name
        // and stash the aliases so the summary + follow-ups can mention
        // them. The cache filter uses `includes()` on the customer
        // name, so a partial match against "SVG-HUNGARY GÉPGYÁR ZRT."
        // is achieved with the bare "SVG" token as well — but using
        // the canonical name gives cleaner hit counts and matches
        // more tickets when the same real company has alias variants.
        plan.filters.customer = probe.canonical;
        // If the question was just the company name (no leftover
        // descriptive q), promote to the fleet-overview intent.
        // Otherwise the question is a compound (e.g. "Hány y2 hajtás
        // … az SVG HDMC …") and we keep the existing intent so the
        // descriptive q is threaded through the search.
        if (!plan.filters.q || plan.filters.q.length < 3) {
          plan.intent = "customer_fleet_overview";
        }
      } else {
        // False positive — drop the customer filter and let the
        // question fall through to the device / free-text branch.
        delete plan.filters.customer;
        delete plan.weak_customer;
      }
    }

    // Contextualize the follow-up chips: the router's follow-ups are
    // static ("Mi a leggyakoribb hibája?") and lose the entity when
    // clicked. Appending the device/sorszam/customer keeps the follow-up
    // scoped to the machine the answer was about. Must run BEFORE
    // expandPlan — the alternates copy top.follow_ups and inherit it.
    plan.follow_ups = contextualizeFollowUps(plan, language);

    // Phase 5.3: drop LLM-injected date_from/date_to when the question
    // does not mention a date and no period was set. The MCP server
    // applies the same guard at the tool wrapper level; this is the
    // answer endpoint's equivalent so the two paths stay consistent.
    const dateGuard = stripLLMDates(body as Record<string, unknown>);
    if (dateGuard.stripped) {
      // If the LLM supplied dates but the question had no date, also
      // clear the period (which might have been overridden to "custom"
      // along with the dates).
      plan.period = undefined;
    }

    // 3) Build the candidate set: top-1 from the router + alternates
    //    synthesized by expandPlan. Score, rank, and pick top-3.
    const alternates = expandPlan(plan);
    const { candidates, threshold } = rankCandidates([plan, ...alternates], { topN: 3 });
    const top = candidates[0];
    const mode: "answer" | "confirm" = top && top.score >= threshold ? "answer" : "confirm";

    // 4) Execute the top-1 plan (so we have results/evidence for the
    //    answer mode). The other candidates carry their plan but the
    //    client only needs their intent + score + summary preview.
    // Phase 7 L1: safe wrappers — see safeBuildSummary for the why.
    const exec = safeExecutePlan(cache, dbs, plan);
    const summary = safeBuildSummary(plan, exec, language, q);

    // 5) Enrich each candidate with a preview summary so the dashboard
    //    can render the "Other interpretations" expander without a
    //    second round-trip. (Per user decision: return all 3 always.)
    const enriched = candidates.map((c): CandidateScore => {
      const ex = safeExecutePlan(cache, dbs, c.plan);
      const s = safeBuildSummary(c.plan, ex, language, q);
      return {
        ...c,
        // Inject the per-candidate execution result. The client can
        // ignore this if it doesn't want to render the alternates.
        plan: { ...c.plan },
      };
    });

    // 5b) Optional render-only LLM rewrite. The deterministic `summary`
    //    above stays untouched (backwards compatible); `summary_llm` is
    //    an ADDITIONAL field the client may render instead. The LLM
    //    never picks tools or facts — it only rewrites this evidence.
    //    Any failure falls back silently: the endpoint must never 500
    //    because of a model outage.
    let summary_llm: string | null = null;
    if (body.llm && llmConfigured()) {
      try {
        summary_llm = await renderLlmAnswer({
          question: q,
          language,
          summary,
          mode,
          candidates: candidates.slice(0, 3).map((c) => ({
            intent: c.intent,
            score: c.score,
            summary: safeBuildSummary(c.plan, safeExecutePlan(cache, dbs, c.plan), language, q),
          })),
          periodLabel: exec.period
            ? language === "hu"
              ? exec.period.label_hu
              : exec.period.label_en
            : null,
        });
      } catch {
        summary_llm = null;
      }
    }

    res.json({
      // Backwards-compat top-level fields
      // Stamp a feedback_answers row keyed by a fresh ULID so the
      // SPA can attach a 👍 / 👎 vote (and admin counters can roll
      // up). On CONFLICT keeps the row in place across re-runs (so
      // vote counts stay attached to the latest text). Non-fatal:
      // a snapshot failure is logged but never 5xx the answer.
      answer_id: (() => {
        const id = newUlid();
        try {
          insertFeedbackAnswer(dbs, {
            answer_id: id,
            q,
            final_text: summary,
            tool_trace: [],
            model: "router-deterministic",
            iterations: 0,
            language,
            resolved_customer: plan.filters.customer ?? null,
            ticket_cards: null,
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(
            JSON.stringify({
              t: new Date().toISOString(),
              msg: "feedback_snapshot_failed",
              endpoint: "/v1/answer",
              error: String((e as Error)?.message ?? e),
            }),
          );
        }
        return id;
      })(),
      q,
      language,
      intent: plan.intent,
      primitive: plan.primitive,
      group_by: plan.group_by ?? null,
      filters: plan.filters,
      period: exec.period,
      summary,
      summary_llm,
      follow_ups: plan.follow_ups,
      results: exec.results,
      evidence: exec.evidence,
      total: exec.total,
      rationale: plan.rationale,
      // New: multi-candidate
      mode,
      confidence: top ? top.score : 0,
      threshold,
      candidates: enriched.map((c, i) => {
        const ex = safeExecutePlan(cache, dbs, c.plan);
        const s = safeBuildSummary(c.plan, ex, language, q);
        return {
          rank: i + 1,
          intent: c.intent,
          primitive: c.plan.primitive,
          score: c.score,
          score_breakdown: c.score_breakdown,
          family: c.family,
          filters: c.plan.filters,
          period: c.plan.period ?? null,
          summary: s,
          follow_ups: c.plan.follow_ups,
          results: ex.results,
          evidence: ex.evidence,
          total: ex.total,
          rationale: c.plan.rationale,
        };
      }),
      mode_rationale: top
        ? `Top: ${top.intent} (${top.score.toFixed(2)}). Threshold: ${threshold}. Mode: ${mode}.`
        : `No candidates.`,
    });
  });

  // ---- /v1/related — cross-database timeline (Phase 4) ----
  r.post("/v1/related", (req, res) => {
    const body = (req.body ?? {}) as {
      sorszam?: string;
      customer?: string;
      device?: string;
      period?: string;
      date_from?: string;
      date_to?: string;
      window_days?: number;
      limit?: number;
      language?: "hu" | "en";
    };
    const language: "hu" | "en" = body.language === "en" ? "en" : "hu";

    const result = findRelated(cache, dbs, {
      sorszam: body.sorszam,
      customer: body.customer,
      device: body.device,
      period: body.period,
      date_from: body.date_from,
      date_to: body.date_to,
      window_days: body.window_days ?? 180,
      limit: body.limit ?? 50,
    });

    const seed = result.seed;
    const n = result.total;
    const sources = result.sources_searched ?? [];
    const summary = language === "hu"
      ? (seed?.sorszam && seed.sorszam !== "(search)"
        ? `${huThe(seed.sorszam)} (${seed.customer ?? "?"}, ${seed.machine_type ?? "?"}) kapcsolódó bejegyzései: ${n} találat (${sources.join(", ")}).`
        : `Kapcsolódó bejegyzések (${seed?.customer ?? "?"}, ${seed?.machine_type ?? "?"}): ${n} találat (${sources.join(", ")}).`)
      : (seed?.sorszam && seed.sorszam !== "(search)"
        ? `Related entries for ${seed.sorszam} (${seed.customer ?? "?"}, ${seed.machine_type ?? "?"}): ${n} hits (${sources.join(", ")}).`
        : `Related entries (${seed?.customer ?? "?"}, ${seed?.machine_type ?? "?"}): ${n} hits (${sources.join(", ")}).`);

    res.json({
      ...result,
      summary,
      language,
    });
  });

  return r;
}

type ExecResult = {
  results: any[];
  evidence: Record<string, EvidenceTicket[]>;
  total: number;
  period: {
    token: string | null;
    resolved_token: string;
    date_from: string | null;
    date_to: string | null;
    label_en: string;
    label_hu: string;
  } | null;
};

// Phase 6: customer probe. Given a weak customer string like "SVG
// HDMC" or "ContiTech", find the matching customer in the
// `customers` table. Returns the canonical (longest-alias) name +
// all matching aliases + per-alias ticket counts, or null if nothing
// matches (0 hits).
//
// Substring match on `customers.name_ascii` (folded, diacritics
// stripped), ordered by ticket count descending. Cheap (~5-15ms)
// thanks to the `idx_customers_name_ascii` index.
//
// Example: probeCustomer(dbs, "SVG HDMC") for a DB containing
//   - "SVG-HUNGARY GÉPGYÁR ZRT."  → 47 tickets
//   - "SVG HUNGARY"                → 0 tickets  (alias)
// returns
//   {
//     canonical: "SVG-HUNGARY GÉPGYÁR ZRT.",
//     canonical_id: 42,
//     normalized_key: "svg hungary gepgyar",
//     total_tickets: 47,
//     aliases: [{ id: 42, name: "SVG-HUNGARY GÉPGYÁR ZRT.", ticket_count: 47 }, ...]
//   }
type CustomerProbe = {
  canonical: string;
  canonical_id: number;
  normalized_key: string;
  total_tickets: number;
  aliases: { id: number; name: string; ticket_count: number }[];
};

const SUFFIX_PATTERNS = [
  /\bkft\.?\b/gi, /\bzrt\.?\b/gi, /\bnyrt\.?\b/gi, /\bbt\.?\b/gi,
  /\bkkt\.?\b/gi, /\bév\.?\b/gi, /\bévf\.?\b/gi, /\bag\b/gi,
  /\bgmbh\b/gi, /\bllc\b/gi, /\binc\.?\b/gi, /\bltd\.?\b/gi,
  /\bs\.?r\.?o\.?\b/gi, /\bspol\.?\b/gi, /\bsro\b/gi,
  /\bs\.p\.?a\.?\b/gi, /\bs\.a\.?\b/gi, /\bco\.?\b/gi,
  /\bplc\b/gi, /\bnv\b/gi, /\bbv\b/gi, /\b(rt|rt\.)\b/gi,
];
const STOP_WORDS_CUSTOMER = [
  "magyarorszag", "magyarorszagi", "hungary", "hungarian",
  "ipari", "kereskedelmi", "es", "es szolgaltato", "szolgaltato",
  "vallalat", "uzem", "gyar", "uzemegyseg",
];
function normalizeForCanonical(s: string): string {
  let out = foldAccents(s);
  for (const p of SUFFIX_PATTERNS) out = out.replace(p, " ");
  out = out.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (const w of STOP_WORDS_CUSTOMER) {
    out = out.replace(new RegExp(`\\b${w}\\b`, "g"), "");
  }
  return out.replace(/\s+/g, " ").trim();
}

function probeCustomer(dbs: OpenDbs, weak: string): CustomerProbe | null {
  if (!weak || weak.length < 2) return null;
  const folded = foldAccents(weak);
  // Two-tier match strategy for the user's colloquial short form
  // against the canonical customer name:
  //   1) Full substring match. Works for cases like "ContiTech"
  //      → "ContiTech Magyarország Kft." (the user's phrase is a
  //      contiguous substring of the canonical name).
  //   2) Per-token match. Required for cases like "SVG HDMC"
  //      → "SVG-HUNGARY GÉPGYÁR ZRT." (the user's tokens are
  //      abbreviations / project codes, not substrings of the
  //      legal name). We require ALL tokens to be substrings of
  //      the canonical name_ascii, then rank candidates by
  //      (token-coverage, total_tickets).
  // Tier 2 is what makes the probe useful for short colloquial
  // references to a real customer. Without it, the probe returns
  // null on the first deploy target and the user gets a false
  // negative on the very question that motivated Phase 6.
  const tokens = folded.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  const like = `%${folded.replace(/[%_]/g, "")}%`;
  let rows: { id: number; name: string; ticket_count: number }[];
  try {
    // Tier 1: full substring first (cheaper, more specific).
    rows = dbs.spec.query(
      `SELECT c.id, c.name,
              (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) AS ticket_count
         FROM customers c
         WHERE c.name_ascii LIKE ?`,
    ).all(like) as typeof rows;
  } catch {
    return null;
  }
  if (rows.length === 0) {
    // Tier 2: per-token OR. Real customers are often named with
    // abbreviations ("HDMC" for the user's machine) that the
    // customer record doesn't contain. So we accept candidates
    // where AT LEAST ONE of the user's tokens is a substring of
    // name_ascii. This catches "SVG HDMC" against "SVG HOLDING
    // NÓGRÁDI GÉPGYÁRTÓ KFT.  SVG HUNGARY KFT." (the "SVG"
    // token matches, the customer's own "HDMC" reference is
    // elsewhere — the user knows their machine, we don't).
    // Cost: ~5-15ms over the ~3k customer rows. The ranking
    // (best = most tickets, then shortest name) prefers the
    // alias the user is most likely referring to.
    try {
      const conds = tokens.map(() => `c.name_ascii LIKE ?`).join(" OR ");
      const params = tokens.map((t) => `%${t.replace(/[%_]/g, "")}%`);
      // Cap at 200 rows so an accidentally-broad token (e.g. "Kft"
      // as a fallback if the user typed something weird) doesn't
      // pull in thousands of candidates. The grouping + sort
      // below still picks the best by ticket count.
      rows = dbs.spec.query(
        `SELECT c.id, c.name,
                (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) AS ticket_count
           FROM customers c
           WHERE ${conds}
           ORDER BY (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) DESC
           LIMIT 200`,
      ).all(...params) as typeof rows;
    } catch {
      return null;
    }
  }
  if (rows.length === 0) return null;
  // Group by normalized name to fold alias variants into one
  // canonical group. The user's "SVG HDMC" must match the
  // "SVG-HUNGARY GÉPGYÁR ZRT." group as long as the folded
  // substring is present in the canonical.
  const groups = new Map<string, {
    canonical: string; canonical_id: number; total: number;
    aliases: { id: number; name: string; ticket_count: number }[];
  }>();
  for (const r of rows) {
    const key = normalizeForCanonical(r.name);
    if (!key) continue;
    const g = groups.get(key) ?? { canonical: r.name, canonical_id: r.id, total: 0, aliases: [] };
    g.aliases.push({ id: r.id, name: r.name, ticket_count: r.ticket_count });
    g.total += r.ticket_count;
    if (r.name.length > g.canonical.length) {
      g.canonical = r.name;
      g.canonical_id = r.id;
    }
    groups.set(key, g);
  }
  if (groups.size === 0) return null;
  // Pick the largest group by total ticket count.
  const best = [...groups.values()].sort((a, b) => b.total - a.total)[0]!;
  return {
    canonical: best.canonical,
    canonical_id: best.canonical_id,
    normalized_key: normalizeForCanonical(best.canonical),
    total_tickets: best.total,
    aliases: best.aliases.sort((a, b) => b.ticket_count - a.ticket_count),
  };
}

function executePlan(cache: JobCache, dbs: OpenDbs, plan: RoutePlan): ExecResult {
  // Explicit dates extracted from the question ("napjainktól 2024.05.10-ig
  // visszamenőleg") ride on plan.date_from/date_to with period="custom".
  // Pass them verbatim so resolvePeriod resolves the custom window instead
  // of collapsing to "all" (the pre-fix behavior: "minden idők").
  const period = resolvePeriod(plan.period, new Date(), {
    date_from: plan.date_from ?? null,
    date_to: plan.date_to ?? null,
  });
  const dateFrom = period.date_from ?? undefined;
  dateFrom; // keep tsc happy
  const dateTo = period.date_to ?? undefined;
  dateTo;

  // Helper to project a hit/job into a "ticket summary" shape used by
  // the answer endpoint.
  const projectHit = (job: import("../cache/jobs").JobCard): EvidenceTicket => {
    const reported = job.notes.find((n) => n.kind === "reported");
    const work = job.notes.find((n) => n.kind === "work");
    const free = job.notes.find((n) => n.kind === "free");
    const pick = (reported?.body) || (work?.body) || (free?.body) || "";
    const snippet = pick.length > 200 ? pick.slice(0, 197) + "..." : pick;
    return {
      sorszam: job.sorszam,
      key: job.key,
      reported_at_iso: job.reported_at_iso,
      snippet,
      kategoria: job.problem_kategoria,
      kategoria_inferred: job.kategoria_inferred,
      sulyossag_inferred: job.sulyossag_inferred,
    };
  };

  // Search-based primitives.
  if (plan.primitive === "search_tickets" && plan.intent === "customer_fleet_overview") {
    // Phase 6: 5-section composite. Pulls the customer's tickets in
    // one pass (cache.search honors the period filter), then derives
    // the 5 sections from that pool. The cache's internal sort is
    // by relevance score; for fleet purposes we don't care about the
    // score order, we only need:
    //   - count (total)
    //   - distinct machine_type count
    //   - top 5 machine_type / kategoria_inferred / technician
    //   - last 5 by reported_at_iso descending
    //   - oldest 1 by reported_at_iso ascending
    // cache.stats() handles the top-N; we handle the date sorts
    // ourselves since cache.search doesn't expose an order param.
    const customer = plan.filters.customer;
    if (!customer) return emptyExec(period, plan);
    // The cache's search/stats take date_from/date_to (already
    // resolved from the plan's period by the `period` object above),
    // not a `period` string. Pass the resolved dates verbatim so
    // "ACME ebben a hónapban" and "ACME minden idők" give different
    // views of the same customer.
    const dateFrom = period.date_from ?? undefined;
    const dateTo = period.date_to ?? undefined;
    const all = cache.search({
      customer,
      date_from: dateFrom,
      date_to: dateTo,
      limit: 5000,
    });
    // cache.search returns { hits: [{ job, score }] } — unwrap to the
    // JobCards for the last5 / firstSeen / distinct-machine-count
    // derivations. cache.stats handles its own aggregation.
    const allJobs = all.hits.map((h) => h.job) as Array<{
      sorszam: string;
      devices: Array<{ machine_type?: string | null }>;
      reported_at_iso?: string | null;
    }>;
    const total = all.total;
    const distinctMachines = new Set<string>();
    for (const j of allJobs) {
      for (const d of j.devices) {
        if (d.machine_type) distinctMachines.add(d.machine_type);
      }
    }
    const topMachines = cache.stats({
      group_by: "machine_type",
      customer,
      date_from: dateFrom,
      date_to: dateTo,
      limit: 5,
    });
    const topCategories = cache.stats({
      group_by: "kategoria_inferred",
      customer,
      date_from: dateFrom,
      date_to: dateTo,
      limit: 5,
    });
    const topTechnicians = cache.stats({
      group_by: "technician",
      customer,
      date_from: dateFrom,
      date_to: dateTo,
      limit: 3,
    });
    // Sort by date for last5 + firstSeen
    const byDateDesc = [...allJobs].sort(
      (a, b) => (b.reported_at_iso ?? "").localeCompare(a.reported_at_iso ?? ""),
    );
    const last5 = byDateDesc.slice(0, 5);
    const firstSeen = byDateDesc.length > 0
      ? (byDateDesc[byDateDesc.length - 1]?.reported_at_iso ?? null)
      : null;
    const composite = {
      customer,
      total,
      distinctMachines: distinctMachines.size,
      topMachines: topMachines ?? [],
      topCategories: topCategories ?? [],
      last5: last5 ?? [],
      firstSeen,
      topTechnicians: topTechnicians ?? [],
    };
    return {
      results: [composite],
      evidence: {},
      total: total,
      period: {
        token: plan.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    };
  }

  if (plan.primitive === "search_tickets" && plan.intent === "problem_solution") {
    // Problem -> solution. The cache's search ANDs q tokens exactly,
    // which rejects declined forms ("kijelzője" vs "kijelző" in the
    // haystack), so we fetch a wider identifier-scoped pool and let
    // buildSummary prefix-match the problem tokens against the note
    // text. Without an identifier we try the strict q search first,
    // then fall back to a recent scan when it comes back empty.
    const hasIdentifier = !!(plan.filters.device || plan.filters.sorszam || plan.filters.customer);
    let out;
    if (hasIdentifier) {
      out = cache.search({
        q: undefined,
        customer: plan.filters.customer,
        device: plan.filters.device,
        status: plan.filters.status,
        kategoria: plan.filters.kategoria,
        controller: plan.filters.controller,
        kategoria_inferred: plan.filters.kategoria_inferred,
        sulyossag_inferred: plan.filters.sulyossag_inferred,
        alkategoria_inferred: plan.filters.machine_type,
        date_from: dateFrom,
        date_to: dateTo,
        limit: 300,
        offset: 0,
      });
    } else {
      out = cache.search({
        q: plan.filters.q,
        customer: undefined,
        device: undefined,
        status: plan.filters.status,
        kategoria: plan.filters.kategoria,
        controller: plan.filters.controller,
        kategoria_inferred: plan.filters.kategoria_inferred,
        sulyossag_inferred: plan.filters.sulyossag_inferred,
        alkategoria_inferred: plan.filters.machine_type,
        date_from: dateFrom,
        date_to: dateTo,
        limit: 50,
        offset: 0,
      });
      if (out.total === 0) {
        out = cache.search({
          q: undefined,
          customer: undefined,
          device: undefined,
          status: plan.filters.status,
          kategoria: plan.filters.kategoria,
          controller: plan.filters.controller,
          kategoria_inferred: plan.filters.kategoria_inferred,
          sulyossag_inferred: plan.filters.sulyossag_inferred,
          alkategoria_inferred: plan.filters.machine_type,
          date_from: dateFrom,
          date_to: dateTo,
          limit: 300,
          offset: 0,
        });
      }
    }
    return {
      results: out.hits.map((h) => stripHaystack(h.job)),
      evidence: {},
      total: out.total,
      period: {
        token: plan.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    };
  }

  if (plan.primitive === "search_tickets" && plan.intent === "part_spec") {
    // Part-spec: the cache's exact-token AND search cannot reach the
    // answer ticket — "csapágy" never matches "csapágyak" (plural), and
    // the 100-row cap drops older tickets. So we fetch an
    // identifier-scoped pool and let partSpecSummary rank by part-token
    // matches and extract type/quantity from the work notes:
    //   - q=<identifier> covers serials that live in note text or the
    //     device raw ("EmL-610 (08277;M15250;M09192) ..."),
    //   - device=<identifier> covers hyphenated forms ("M-09192") via
    //     the hyphen-insensitive device filter,
    //   - findBySorszam covers a sorszam-scoped part question.
    // Without an identifier we fall back to a global part-token pool
    // (best-effort; the honest not-found covers the 100-cap blind spot).
    const partQ = (plan.filters.q ?? "").trim();
    const seen = new Set<number>();
    const cards: Array<import("../cache/jobs").JobCard> = [];
    const add = (hits: Array<{ job: import("../cache/jobs").JobCard }>) => {
      for (const h of hits) {
        if (!seen.has(h.job.key)) {
          seen.add(h.job.key);
          cards.push(h.job);
        }
      }
    };
    if (plan.filters.sorszam) {
      const card = findBySorszam(cache, plan.filters.sorszam);
      if (card) add([{ job: card }]);
    }
    if (plan.filters.device) {
      const r1 = cache.search({ q: plan.filters.device, limit: 100, offset: 0 }).hits;
      const r2 = cache.search({ device: plan.filters.device, limit: 100, offset: 0 }).hits;
      console.log("[part_spec] device=" + plan.filters.device + " q=" + r1.length + " device=" + r2.length);
      add(r1);
      add(r2);
    }
    if (plan.filters.customer) {
      add(cache.search({ customer: plan.filters.customer, limit: 100, offset: 0 }).hits);
    }
    if (cards.length === 0 && partQ) {
      add(cache.search({ q: partQ, limit: 100, offset: 0 }).hits);
    }
    console.log("[part_spec] total cards=" + cards.length + " partQ=" + JSON.stringify(partQ));
    return {
      results: cards.map((c) => stripHaystack(c)),
      evidence: {},
      total: cards.length,
      period: {
        token: plan.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    };
  }

  if (plan.primitive === "search_tickets") {
    // Phase 5.6 fix: when the router has identified a specific entity
    // (device / sorszam / customer), the leftover `q` prose is
    // descriptive context, not an additional AND filter. Otherwise a
    // question like "Milyen vezérlés található az M26057 gépen?" gets
    // routed with device=M26057 AND q="Milyen vezérlés található az
    // gépen" — the q tokens (milyen, vezérlés, található) won't all
    // appear in the ticket's _haystack, and the AND filter rejects
    // the right result.
    const hasIdentifier = !!(plan.filters.device || plan.filters.sorszam || plan.filters.customer);
    const qForSearch = hasIdentifier ? undefined : plan.filters.q;
    const out = cache.search({
      q: qForSearch,
      customer: plan.filters.customer,
      device: plan.filters.device,
      status: plan.filters.status,
      kategoria: plan.filters.kategoria,
      sulyossag: undefined,
      controller: plan.filters.controller,
      kategoria_inferred: plan.filters.kategoria_inferred,
      sulyossag_inferred: plan.filters.sulyossag_inferred,
      alkategoria_inferred: plan.filters.machine_type,
      date_from: dateFrom,
      date_to: dateTo,
      limit: plan.limit ?? 20,
      offset: 0,
    });
    return {
      results: out.hits.map((h) => stripHaystack(h.job)),
      evidence: {},
      total: out.total,
      period: {
        token: plan.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    };
  }

  if (plan.primitive === "find_ticket_by_sorszam") {
    if (!plan.filters.sorszam) return emptyExec(period, plan);
    const card = findBySorszam(cache, plan.filters.sorszam);
    if (!card) return { ...emptyExec(period, plan), results: [] };
    return {
      results: [stripHaystack(card)],
      evidence: {},
      total: 1,
      period: {
        token: plan.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    };
  }

  if (plan.primitive === "find_related_tickets") {
    const result = findRelated(cache, dbs, {
      sorszam: plan.filters.sorszam,
      customer: plan.filters.customer,
      device: plan.filters.device,
      period: plan.period,
      date_from: plan.date_from,
      date_to: plan.date_to,
      window_days: 180,
      limit: plan.limit ?? 50,
    });
    return {
      results: [result],
      evidence: {},
      total: result.total,
      period: {
        token: plan.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    };
  }

  if (plan.primitive === "stats") {
    // Same fix as search_tickets above: with a specific identifier,
    // the leftover q is descriptive, not a hard filter.
    const hasIdentifier = !!(plan.filters.device || plan.filters.sorszam || plan.filters.customer);
    const qForStats = hasIdentifier ? undefined : plan.filters.q;
    const results = cache.stats({
      group_by: (plan.group_by as any) ?? "customer",
      q: qForStats,
      customer: plan.filters.customer,
      device: plan.filters.device,
      status: plan.filters.status,
      date_from: dateFrom,
      date_to: dateTo,
      kategoria: plan.filters.kategoria,
      sulyossag: undefined,
      controller: plan.filters.controller,
      kategoria_inferred: plan.filters.kategoria_inferred,
      sulyossag_inferred: plan.filters.sulyossag_inferred,
      alkategoria_inferred: plan.filters.machine_type,
      limit: plan.limit ?? 50,
    });
    // Build evidence for top-3 groups using sampleTickets.
    const top3 = results.slice(0, 3);
    const evidence: Record<string, EvidenceTicket[]> = {};
    for (const r of top3) {
      const samples = cache.sampleTickets({
        customer: plan.filters.customer,
        device: plan.filters.device,
        status: plan.filters.status,
        date_from: dateFrom,
        date_to: dateTo,
        kategoria: plan.filters.kategoria,
        controller: plan.filters.controller,
        kategoria_inferred: plan.filters.kategoria_inferred,
        sulyossag_inferred: plan.filters.sulyossag_inferred,
        alkategoria_inferred: plan.filters.machine_type,
        group_by: r.name,
        group_by_field: (plan.group_by as any) ?? "customer",
        limit: 2,
      });
      evidence[r.name] = samples.map((s) => ({
        sorszam: s.sorszam,
        key: s.key,
        reported_at_iso: s.reported_at_iso,
        snippet: s.snippet,
        kategoria: s.kategoria,
        kategoria_inferred: s.kategoria_inferred,
        sulyossag_inferred: s.sulyossag_inferred,
      }));
    }
    return {
      results,
      evidence,
      total: results.length,
      period: {
        token: plan.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    };
  }

  if (plan.primitive === "top_hubs") {
    // Phase 5b: ticket-linkage hubs. Top tickets by indegree in the
    // sorszam cross-reference graph.
    const hubs = cache.topHubs({ limit: plan.limit ?? 10, include_samples: 3 });
    return {
      results: hubs,
      evidence: {},
      total: hubs.length,
      period: {
        token: plan.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    };
  }

  // Other primitives (recurring, internal, szev, telephely, etc.) are
  // handled by the legacy endpoints. The router still gives the LLM
  // a clear `primitive` and `intent`, so the model can call the right
  // tool directly when it needs the full response. We return an empty
  // result and the rationale so the LLM can fall back to the right
  // tool.
  return emptyExec(period, plan);
}

function emptyExec(period: ReturnType<typeof resolvePeriod>, plan: RoutePlan): ExecResult {
  return {
    results: [],
    evidence: {},
    total: 0,
    period: {
      token: plan.period ?? null,
      resolved_token: period.resolved_token,
      date_from: period.date_from,
      date_to: period.date_to,
      label_en: period.label_en,
      label_hu: period.label_hu,
    },
  };
}

function findBySorszam(cache: JobCache, sorszam: string): import("../cache/jobs").JobCard | null {
  for (const card of cache.allJobs()) {
    if (card.sorszam.toUpperCase() === sorszam.toUpperCase()) return card;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------
// We try to write a one-sentence answer in the caller's language. The
// LLM can keep this verbatim or rewrite it. The point is to give it
// something to *cite*, not to free-form answer.

// Fold + tokenize like the router (NFD strip + lowercase).
function foldTokens(s: string): Set<string> {
  const t = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return new Set(t.split(/[^a-z0-9]+/).filter((x) => x.length > 0));
}

// A problem token matches a note token when they share a >=5-char
// prefix (or the q token is shorter and the note token starts with
// it). Handles declined Hungarian forms: "kijelzője" matches
// "kijelző", "elsötétült" matches "elsötétült".
function problemTokenMatches(qTok: string, noteTok: string): boolean {
  if (qTok.length >= 5) return noteTok.startsWith(qTok.slice(0, 5));
  return noteTok.startsWith(qTok);
}

// Problem -> solution summary. The user describes a symptom
// ("elsötétült az NCT 204 kijelzője, hogyan tudom megjavítani?") and
// we answer with what was actually done in the past: matched
// historical tickets ranked by how many problem tokens their fault /
// work notes contain, each cited as "sorszam (customer, date): work".
// No LLM: pure token prefix matching against the note bodies.
function problemSolutionSummary(plan: RoutePlan, results: any[], language: "hu" | "en"): string {
  const problem = (plan.filters.q ?? "").trim();
  const problemTokens = problem ? [...foldTokens(problem)].filter((t) => t.length >= 4) : [];
  const entity = plan.filters.device ?? plan.filters.sorszam ?? plan.filters.customer ?? null;

  // Results arrive recent-desc already; rank by matched-token count
  // (stable sort keeps recency within equal hits).
  const matched: Array<{ card: any; hits: number }> = [];
  for (const card of results) {
    if (!card) continue;
    const notes: Array<{ kind?: string; body?: string }> = Array.isArray(card.notes) ? card.notes : [];
    const noteText = notes.map((n) => (n?.body ?? "")).join(" ");
    if (!noteText) continue;
    const noteTokens = foldTokens(noteText);
    let hits = 0;
    for (const pt of problemTokens) {
      for (const nt of noteTokens) {
        if (problemTokenMatches(pt, nt)) { hits++; break; }
      }
    }
    if (hits > 0) matched.push({ card, hits });
  }
  matched.sort((a, b) => b.hits - a.hits);

  const cite = (card: any): string => {
    const notes: Array<{ kind?: string; body?: string }> = Array.isArray(card.notes) ? card.notes : [];
    const work = notes.find((n) => n?.kind === "work")?.body;
    const reported = notes.find((n) => n?.kind === "reported")?.body;
    const pick = (work ?? reported ?? "").replace(/\s+/g, " ").trim();
    const short = pick.length > 110 ? pick.slice(0, 107) + "..." : pick;
    const who = card.customer?.name ?? "?";
    const when = card.reported_at_iso ?? "?";
    return `${card.sorszam} (${who}, ${when}): ${short || "?"}`;
  };

  if (matched.length > 0) {
    const top = matched.slice(0, 5).map((m) => cite(m.card)).join(" | ");
    if (language === "hu") {
      const scope = entity ? `${huThe(entity)} gépen` : "A rendszerben";
      const prob = problem ? ` ${huDefiniteArticle(problem)} "${problem}" problémára` : "";
      return `${scope}${prob} ${matched.length} hasonló javítás található: ${top}.`;
    }
    const scope = entity ? `On the ${entity} machine` : "In the system";
    const prob = problem ? ` for "${problem}"` : "";
    const plural = matched.length === 1 ? "fix" : "fixes";
    return `${scope}, ${matched.length} similar ${plural} found${prob}: ${top}.`;
  }

  if (language === "hu") {
    const scope = entity ? `${huDefiniteArticle(entity)} ${entity} gépen` : "a rendszerben";
    const prob = problem ? ` ${huDefiniteArticle(problem)} "${problem}" problémára` : "";
    return `Nem található korábbi hasonló javítás ${scope}${prob}.`;
  }
  const scope = entity ? `on the ${entity} machine` : "in the system";
  const prob = problem ? ` for "${problem}"` : "";
  return `No similar fix found ${scope}${prob}.`;
}

// ---------------------------------------------------------------------------
// Part-spec summary ("X tengely golyósorsó csapágyak típusa és mennyisége")
// ---------------------------------------------------------------------------
// A part-spec question ("csapágy típusa és mennyisége, M09192 munkánál")
// is answered with the type/quantity extracted from historical work
// notes, e.g. B25082210: "X tengely golyósorsó csapágyak cseréje 4 db
// 30TAC62CSUHPN7C". No LLM: the pool (executePlan) is identifier-scoped,
// cards are ranked by part-token matches, and the spec is extracted with
// deterministic regexes (quantity "N db/darab", type = uppercase+digit
// part codes). Zero matches -> honest not-found, never a hit counter.

const PART_SPEC_PART_WORDS: string[] = [
  "csapagy", "golyosorso", "orso", "szij", "kuplung", "tengelykapcsolo",
  "tomites", "tapegyseg", "rele", "biztositek", "alkatresz", "csavar",
  "gyuru", "ventillator", "kijelzo", "kepernyo", "monitor", "akku",
  "elem", "motor", "pumpa", "szivattyu", "heveder", "lanc", "fogaskerek",
  "szenkefe", "merocella", "kodolo", "kontakt", "potenciometer", "tengely",
];
const PART_SPEC_SPEC_STEMS: string[] = [
  "tipus", "mennyiseg", "meret", "cikkszam", "feszultseg", "teljesitmeny",
  "nyomatek", "fordulatszam", "atmero", "hossz", "szelesseg",
  "milyen", "melyik", "mekkora", "mennyi", "hany", "mely",
];
const PART_SPEC_MIN = 4;
// Words that must not appear in the echoed part phrase ("típusa és
// mennyisége" is the question's request, not the part being asked about).
const PART_SPEC_DISPLAY_STOP = new Set([
  "a", "az", "egy", "es", "van", "munkanal", "melyik", "milyen", "mekkora",
  "mennyi", "hany", "mely", "milyet", "milyek",
]);
const PART_SPEC_QTY_RE = /(\d{1,3})\s*(?:db|darab)\b/i;
const PART_SPEC_YEAR_RE = /^(19|20)\d{2}$/;

// Which part stems does the question name? A question token matches a
// stem when it shares its >=4-char prefix ("golyós" -> golyosorso,
// "csapágyak" -> csapagy, "orsó" -> orso).
function partSpecPartStems(q: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of foldTokens(q)) {
    for (const w of PART_SPEC_PART_WORDS) {
      if (tok.startsWith(w.slice(0, PART_SPEC_MIN)) && !seen.has(w)) {
        seen.add(w);
        out.push(w);
        break;
      }
    }
  }
  return out;
}

// A part stem matches a note token when they share a >=4-char prefix or
// one contains the other ("orsó" is embedded in "golyósorsó" — the
// compound word merges "golyós" + "orsó" into one token).
function partTokenMatches(qTok: string, noteTok: string): boolean {
  const q = qTok.slice(0, PART_SPEC_MIN);
  const nt = noteTok.slice(0, PART_SPEC_MIN);
  if (q === nt) return true;
  if (qTok.length >= PART_SPEC_MIN && noteTok.includes(qTok)) return true;
  if (noteTok.length >= PART_SPEC_MIN && qTok.includes(noteTok)) return true;
  return false;
}

// Fold + tokenize into an ARRAY that preserves duplicates (the Set-based
// foldTokens collapses repeated axis letters, so "Y burkolatok ..., Y
// golyósorsó ..." would hide the second Y that sits next to the part word).
function foldTokensArr(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((x) => x.length > 0);
}

// Which axis (X/Y/Z) does the text refer to? A standalone axis letter
// whose NEXT token is a part word or "tengely" ("X tengely golyósorsó
// csapágyak", "Y golyósorsó kiszerelés"), or a fused token
// ("x-tengely"). Only X/Y/Z count as standalone — Hungarian "A tengely"
// is the article "a" and would be a false A-axis. Used to stop a
// question about the X-axis from being answered by a (possibly newer)
// Y-axis ticket that matches the same part stems.
function noteAxis(body: string): string | null {
  const toks = foldTokensArr(body);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const m = t.match(/^([xyz])-?(teng|golyos|csapagy|orso|orsos)$/);
    const letter = m ? m[1] : /^[xyz]-?$/.test(t) ? t : null;
    if (!letter) continue;
    if (!m) {
      const nx = toks[i + 1] ?? "";
      const ok =
        nx.startsWith("teng") ||
        PART_SPEC_PART_WORDS.some((w) => nx.startsWith(w.slice(0, PART_SPEC_MIN)));
      if (!ok) continue;
    }
    return letter.toUpperCase();
  }
  return null;
}

// Extract { quantity, type } from a card's notes. Work notes first
// (what was actually fitted), then reported. Quantity is "N db/darab";
// type is a raw token with letters AND digits ("30TAC62CSUHPN7C",
// "6205-2RS") that is not a pure number, year, or sorszam-like
// reference ("B25082210", "A2026"). Prefer the type in the same
// sentence fragment as the quantity or the part word.
function extractPartSpec(card: any): { qty: string | null; type: string | null } | null {
  const notes: Array<{ kind?: string; body?: string }> = Array.isArray(card.notes) ? card.notes : [];
  const ordered = [
    ...notes.filter((n) => n?.kind === "work"),
    ...notes.filter((n) => n?.kind === "reported"),
    ...notes.filter((n) => n?.kind !== "work" && n?.kind !== "reported"),
  ];
  for (const note of ordered) {
    const body = (note?.body ?? "").replace(/\s+/g, " ").trim();
    if (!body) continue;
    const qtyM = body.match(PART_SPEC_QTY_RE);
    const qty = qtyM ? `${qtyM[1]} db` : null;
    const frags = body.split(/[,;()\n]+/);
    const fragHasPart = (fr: string): boolean => {
      const toks = [...foldTokens(fr)];
      return PART_SPEC_PART_WORDS.some((w) => {
        const p = w.slice(0, PART_SPEC_MIN);
        return toks.some((t) => t.startsWith(p));
      });
    };
    const anchor = frags.find((fr) => PART_SPEC_QTY_RE.test(fr)) ?? frags.find(fragHasPart);
    if (!anchor) continue;
    const rawTokens = body.split(/[^A-Za-z0-9-]+/).filter((t) => t.length >= 5);
    const types = rawTokens.filter((t) => {
      const tt = t.replace(/-/g, "");
      if (/^\d+$/.test(tt)) return false;
      if (PART_SPEC_YEAR_RE.test(tt)) return false;
      if (/^[a-z]\d{4,}$/i.test(tt)) return false; // B25082210 / A2026 / B-2026
      if (!/[A-Za-z]/.test(tt) || !/\d/.test(tt)) return false;
      return true;
    });
    if (types.length === 0 && !qty) continue;
    let type: string | null = null;
    const anchorTokens = foldTokens(anchor);
    for (const t of types) {
      if (anchorTokens.has(t.toLowerCase())) { type = t; break; }
    }
    if (!type && types.length > 0) type = types[0];
    return { qty, type };
  }
  return null;
}

function partSpecSummary(plan: RoutePlan, results: any[], language: "hu" | "en"): string {
  const entity = plan.filters.device ?? plan.filters.sorszam ?? plan.filters.customer ?? null;
  const partQ = (plan.filters.q ?? "").trim();
  const stems = partSpecPartStems(partQ);

  // Echo phrase: the original (accented) part words minus request
  // words ("típusa és mennyisége", "munkánál").
  const phrase = partQ
    .split(/\s+/)
    .filter((w) => w.length >= 2 || /^[xyz]$/i.test(w))
    .filter((w) => {
      const fw = w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (PART_SPEC_DISPLAY_STOP.has(fw)) return false;
      for (const sw of PART_SPEC_SPEC_STEMS) {
        if (fw.startsWith(sw.slice(0, PART_SPEC_MIN))) return false;
      }
      return true;
    })
    .join(" ");

  // Rank pool cards by how many part stems their note text contains,
  // then extract a spec from EVERY candidate and score it:
  //   - part-stem hits: +10 each (coverage of the question's part words)
  //   - complete (type + quantity): +40; partial (type or quantity): +5
  //   - axis: +20 when the card is on the SAME axis the question names
  //     ("X tengely ..."), -20 on a different axis — a newer Y-axis
  //     ticket must not answer an X-axis question
  // Tie-breaks: longer type code (more specific part number), then
  // recency. Cards with no extractable spec are dropped.
  const matched: Array<{ card: any; hits: number }> = [];
  for (const card of results) {
    if (!card) continue;
    const notes: Array<{ kind?: string; body?: string }> = Array.isArray(card.notes) ? card.notes : [];
    const noteText = notes.map((n) => (n?.body ?? "")).join(" ");
    if (!noteText) continue;
    const noteTokens = foldTokens(noteText);
    let hits = 0;
    for (const st of stems) {
      for (const nt of noteTokens) {
        if (partTokenMatches(st, nt)) { hits++; break; }
      }
    }
    if (hits > 0) matched.push({ card, hits });
  }

  const qAxis = noteAxis(partQ);
  const scored: Array<{
    card: any;
    spec: { qty: string | null; type: string | null };
    score: number;
    typeLen: number;
  }> = [];
  for (const m of matched) {
    const spec = extractPartSpec(m.card);
    if (!spec || (!spec.type && !spec.qty)) continue;
    let score = m.hits * 10;
    if (spec.type && spec.qty) score += 40;
    else score += 5;
    const notes: Array<{ body?: string }> = Array.isArray(m.card.notes) ? m.card.notes : [];
    const nAxis = noteAxis(notes.map((n) => n?.body ?? "").join(" "));
    if (qAxis && nAxis) score += nAxis === qAxis ? 20 : -20;
    scored.push({ card: m.card, spec, score, typeLen: spec.type?.length ?? 0 });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.typeLen - a.typeLen ||
      (b.card.reported_at_iso ?? "").localeCompare(a.card.reported_at_iso ?? ""),
  );
  const best = scored[0] ?? null;

  if (best) {
    const { card, spec } = best;
    const { type, qty } = spec;
    const who = card.customer?.name ?? "?";
    const when = card.reported_at_iso ?? "?";
    const src = `${card.sorszam} (${who}, ${when})`;
    const head = phrase
      ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} (${entity ?? "?"})`
      : `${entity ?? "?"} alkatrész-specifikációja`;
    const parts: string[] = [];
    if (type) parts.push(language === "hu" ? `típus: ${type}` : `type: ${type}`);
    if (qty) parts.push(language === "hu" ? `mennyiség: ${qty}` : `quantity: ${qty}`);
    if (language === "hu") {
      return `${head}: ${parts.join("; ")} — ${huCite(card.sorszam)} jegy szerint (${who}, ${when}).`;
    }
    return `${head}: ${parts.join("; ")} — per work order ${src}.`;
  }

  if (language === "hu") {
    return entity
      ? `${huThe(entity)} géphez nem található alkatrész-specifikáció (típus/mennyiség) a jegyekben.`
      : "Nem található alkatrész-specifikáció (típus/mennyiség) a jegyekben.";
  }
  return entity
    ? `No part specification (type/quantity) found in the work orders for ${entity}.`
    : "No part specification (type/quantity) found in the work orders.";
}

// ---------------------------------------------------------------------------
// Device-history summary ("Kérem az M17191 gép előéletét napjainktól
// 2024.05.10-ig visszamenőleg")
// ---------------------------------------------------------------------------
// A machine-history question wants the chronological ticket list, not a
// bare hit counter ("12 találat 2024-05-10 → 2026-08-17. Az első
// sorszám: B25092602."). Triggered only when the device-scoped question
// carries history vocabulary ("előélet", "történet", "előzmény",
// "visszamenőleg", "mi történt", "history", "timeline") — plain device
// list questions keep the terse counter.

const HISTORY_WORDS: string[] = [
  "eloelet", "tortenet", "elozmeny", "visszamenoleg", "mi tortent",
  "history", "timeline",
];

function isHistoryRequest(text: string): boolean {
  const flat = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ");
  return HISTORY_WORDS.some((w) => flat.includes(w));
}

function deviceHistorySummary(
  plan: RoutePlan,
  results: any[],
  total: number,
  periodLabel: string,
  language: "hu" | "en",
): string {
  const entity = plan.filters.device ?? plan.filters.sorszam ?? "?";
  const rows = results.slice(0, 8).map((card: any): string => {
    const notes: Array<{ kind?: string; body?: string }> = Array.isArray(card?.notes) ? card.notes : [];
    const work = notes.find((n) => n?.kind === "work")?.body;
    const reported = notes.find((n) => n?.kind === "reported")?.body;
    const free = notes.find((n) => n?.kind === "free")?.body;
    const pick = (work ?? reported ?? free ?? "").replace(/\s+/g, " ").trim();
    const short = pick.length > 70 ? `${pick.slice(0, 67)}...` : pick;
    const who = card?.customer?.name ?? "?";
    const when = card?.reported_at_iso ?? "?";
    return `${card?.sorszam ?? "?"} (${when}${who !== "?" ? `, ${who}` : ""}): ${short || "?"}`;
  });
  const more = total > rows.length ? " …" : "";
  const periodPart = /^minden/.test(periodLabel) ? "" : ` ${periodLabel}`;
  if (language === "hu") {
    return `${huThe(entity)}${periodPart} előzményei (${total} jegy): ${rows.join("; ")}${more}.`;
  }
  const enPeriod = /^all time$/.test(periodLabel) ? "" : `, ${periodLabel}`;
  return `History for ${entity}${enPeriod} (${total} tickets): ${rows.join("; ")}${more}.`;
}

/**
 * Phase 7 L1: safe wrapper around buildSummary that NEVER throws.
 *
 * Background: buildSummary is called from four places in this file,
 * including two synchronous `.map(c => ...)` callbacks (lines ~175
 * and ~268). A throw inside `.map` propagates straight out of the
 * express request handler and reaches Bun as an uncaught exception
 * — which kills the process. systemd restarts in 5s, but the cache
 * rebuild takes ~3 min, so the user sees the service as "dead".
 *
 * The uncaughtException guard in index.ts is the last-resort net
 * (L1b). This wrapper is the FIRST line of defence: convert any
 * throw into a fallback summary string so the request can still
 * complete with a 200. The fallback is logged so the dev team can
 * see which question shape exposed the bug.
 */
function safeBuildSummary(
  plan: RoutePlan,
  exec: ExecResult,
  language: "hu" | "en",
  q?: string,
): string {
  try {
    return buildSummary(plan, exec, language, q);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        msg: "build_summary_failed",
        intent: plan.intent,
        primitive: plan.primitive,
        error: String((e as Error)?.message ?? e),
        stack: String((e as Error)?.stack ?? "").split("\n").slice(0, 3).join(" | "),
        results_len: exec.results?.length ?? 0,
        total: exec.total,
        q_preview: (q ?? "").slice(0, 80),
      }),
    );
    // Honest fallback: tell the user the question surfaced an
    // internal error and the dev team has been notified, with the
    // raw count so they at least see something useful. Don't
    // pretend we found nothing.
    const t = exec.total ?? 0;
    return language === "hu"
      ? `(Belső hiba a válasz összeállításakor — a fejlesztői csapat értesítve. Nyers találatszám: ${t}.)`
      : `(Internal error while composing the answer — the dev team has been notified. Raw result count: ${t}.)`;
  }
}

/** Same wrapper for executePlan. Mostly defensive — executePlan
 *  is in-memory, but a future cross-DB probe call could throw if
 *  the spec DB is being mutated. We don't want that throw to reach
 *  the .map() callback either. */
function safeExecutePlan(
  cache: JobCache,
  dbs: OpenDbs,
  plan: RoutePlan,
): ExecResult {
  try {
    return executePlan(cache, dbs, plan);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        msg: "execute_plan_failed",
        intent: plan.intent,
        primitive: plan.primitive,
        error: String((e as Error)?.message ?? e),
      }),
    );
    return {
      results: [],
      evidence: {},
      total: 0,
      period: null as any,
    };
  }
}

function buildSummary(plan: RoutePlan, exec: ExecResult, language: "hu" | "en", q?: string): string {
  const top = exec.results[0] as any;
  const period = exec.period;
  const periodLabel = period ? (language === "hu" ? period.label_hu : period.label_en) : (language === "hu" ? "minden időszakban" : "all time");

  if (plan.intent === "find_ticket_by_sorszam") {
    if (exec.total === 0) return language === "hu"
      ? `Nem található ${huCite(plan.filters.sorszam)} ticket.`
      : `No ticket found with sorszam ${plan.filters.sorszam}.`;
    const t = exec.results[0] as any;
    // Answer attribute questions directly: "Milyen vezérlés van a
    // B26071801 munkán?" should say the controller, not just echo the
    // sorszam + customer. Fall back to the full question text — the
    // router drops single leftover tokens ("B26071801 vezérlés" keeps
    // no q), so detectAttr on filters.q alone would miss them.
    const attr = detectAttr(plan.filters.q ?? q ?? "");
    if (attr) {
      const value = extractAttr(t, attr);
      if (value) {
        return attrSentence({
          entity: plan.filters.sorszam ?? t.sorszam ?? "?",
          attr,
          value,
          source: cardSource(t),
          language,
        });
      }
    }
    return language === "hu"
      ? `${t.sorszam} — ${t.customer?.name ?? "?"}, ${t.reported_at_iso ?? "?"}${t.problem_kategoria ? `, ${t.problem_kategoria}` : ""}${t.kategoria_inferred ? ` (becsült: ${t.kategoria_inferred})` : ""}.`
      : `${t.sorszam} — ${t.customer?.name ?? "?"}, ${t.reported_at_iso ?? "?"}${t.problem_kategoria ? `, ${t.problem_kategoria}` : ""}${t.kategoria_inferred ? ` (inferred: ${t.kategoria_inferred})` : ""}.`;
  }

  if (plan.intent === "find_related") {
    const result = (exec.results[0] as any);
    if (!result || exec.total === 0) return language === "hu"
      ? "Nem található kapcsolódó bejegyzés."
      : "No related entries found.";
    const seed = result.seed;
    const n = result.total;
    const sources = result.sources_searched ?? [];
    const sourcesStr = sources.join(", ");
    if (language === "hu") {
      return seed?.sorszam && seed.sorszam !== "(search)"
        ? `${huThe(seed.sorszam)} (ügyfél: ${seed.customer ?? "?"}, gép: ${seed.machine_type ?? "?"}) kapcsolódó bejegyzései: ${n} találat (${sourcesStr}).`
        : `Kapcsolódó bejegyzések (${seed?.customer ?? "?"}, ${seed?.machine_type ?? "?"}): ${n} találat (${sourcesStr}).`;
    }
    return seed?.sorszam && seed.sorszam !== "(search)"
      ? `Related entries for ${seed.sorszam} (${seed.customer ?? "?"}, ${seed.machine_type ?? "?"}): ${n} hits (${sourcesStr}).`
      : `Related entries (${seed?.customer ?? "?"}, ${seed?.machine_type ?? "?"}): ${n} hits (${sourcesStr}).`;
  }

  if (plan.primitive === "stats" && exec.total > 0 && top && typeof top === "object" && "name" in top) {
    const top5 = (exec.results as Array<{ name: string; count: number }>).slice(0, 5);
    const lines = top5.map((r) => `${r.name} (${r.count})`).join(", ");
    // Device-scoped attribute questions routed to stats (e.g. "Milyen
    // vezérlő van az M26057 gépen?" -> top_controllers + device):
    // answer with the dominant group value instead of the generic
    // "A legtöbb hibát okozó vezérlő" phrasing.
    if (plan.filters.device && (plan.intent === "top_controllers" || plan.intent === "top_machine_type")) {
      const attr: "controller" | "machine_type" = plan.intent === "top_controllers" ? "controller" : "machine_type";
      // Skip placeholder groups ("(nincs vezerlo)" / "(nincs megadva)")
      // — the device serial rows in devices[] pollute the group with
      // null controllers, and the placeholder count can beat the real
      // controller. Pick the first group with a real name.
      const real = top5.find((r) => r.name && r.name !== "(nincs vezerlo)" && r.name !== "(nincs megadva)");
      if (real) {
        return attrSentence({
          entity: plan.filters.device,
          attr,
          value: real.name,
          source: cardSource(exec.results[0] as any),
          language,
        });
      }
      // No real group — try direct extraction from a sample ticket
      // (notes may say "Vezérlő: X" even when the structured field is
      // empty).
      const sample = (exec.results[0] as any) ?? (exec.evidence ? Object.values(exec.evidence)[0]?.[0] : null);
      const fallback = extractAttr(sample, attr);
      if (fallback) {
        return attrSentence({
          entity: plan.filters.device,
          attr,
          value: fallback,
          source: cardSource(sample),
          language,
        });
      }
      return language === "hu"
        ? `${huThe(plan.filters.device)} gépen nem található megadott ${attr === "controller" ? "vezérlő" : "géptípus"}.`
        : `No ${attr === "controller" ? "controller" : "machine type"} recorded for ${plan.filters.device}.`;
    }
    if (plan.intent === "top_customers" || plan.intent === "top_customers_in_period") {
      return language === "hu"
        ? `A legtöbb kiszállás ${periodLabel}: ${lines}.`
        : `Most service visits ${periodLabel}: ${lines}.`;
    }
    if (plan.intent === "top_machine_type") {
      return language === "hu"
        ? `A legtöbb hibát okozó géptípus ${periodLabel}: ${lines}.`
        : `Most failure-prone machine types ${periodLabel}: ${lines}.`;
    }
    if (plan.intent === "top_controllers") {
      return language === "hu"
        ? `A legtöbb hibát okozó vezérlő ${periodLabel}: ${lines}.`
        : `Most failure-prone controllers ${periodLabel}: ${lines}.`;
    }
    if (plan.intent === "top_kategoriak_inferred" || plan.intent === "top_kategoriak") {
      return language === "hu"
        ? `A leggyakoribb hibakategóriák ${periodLabel}: ${lines}.`
        : `Most common failure categories ${periodLabel}: ${lines}.`;
    }
    if (plan.intent === "top_sulyossag") {
      return language === "hu"
        ? `A súlyosság-eloszlás ${periodLabel}: ${lines}.`
        : `Severity distribution ${periodLabel}: ${lines}.`;
    }
    if (plan.intent === "top_technicians" || plan.intent === "top_technicians_open") {
      return language === "hu"
        ? `A legtöbb ticketet kezelő technikusok ${periodLabel}: ${lines}.`
        : `Technicians with the most tickets ${periodLabel}: ${lines}.`;
    }
    if (plan.intent === "count_by_status") {
      return language === "hu"
        ? `Státusz szerinti eloszlás ${periodLabel}: ${lines}.`
        : `Status distribution ${periodLabel}: ${lines}.`;
    }
    if (plan.intent === "count_by_month") {
      return language === "hu"
        ? `A legforgalmasabb hónapok: ${lines}.`
        : `Busiest months: ${lines}.`;
    }
    if (plan.intent === "top_customer_open_tickets") {
      return language === "hu"
        ? `A legtöbb nyitott ticket ${periodLabel}: ${lines}.`
        : `Most open tickets ${periodLabel}: ${lines}.`;
    }
    if (plan.intent === "top_customer_critical_tickets" || plan.intent === "critical_open_now") {
      return language === "hu"
        ? `A legtöbb kritikus ticket ${periodLabel}: ${lines}.`
        : `Most critical tickets ${periodLabel}: ${lines}.`;
    }
    if (plan.intent === "customer_top_devices") {
      return language === "hu"
        ? `${plan.filters.customer} legfontosabb géptípusai: ${lines}.`
        : `${plan.filters.customer}'s most serviced machine types: ${lines}.`;
    }
    if (plan.intent === "customer_top_kategoriak") {
      return language === "hu"
        ? `${plan.filters.customer} leggyakoribb hibakategóriái: ${lines}.`
        : `${plan.filters.customer}'s most common failure categories: ${lines}.`;
    }
    if (plan.intent === "customer_top_technicians") {
      return language === "hu"
        ? `${plan.filters.customer} legfontosabb technikusai: ${lines}.`
        : `${plan.filters.customer}'s top technicians: ${lines}.`;
    }
    if (plan.intent === "device_top_problem") {
      return language === "hu"
        ? `${huThe(plan.filters.device)} leggyakoribb hibái: ${lines}.`
        : `${plan.filters.device}'s most common failures: ${lines}.`;
    }
    if (plan.intent === "device_top_customers") {
      // "Melyik ügyfélnél a leggyakoribb az M17191 gépen?" — the
      // customer distribution for THIS device, not the global top.
      return language === "hu"
        ? `${huThe(plan.filters.device)} géphez a legtöbb kiszállás ${periodLabel}: ${lines}.`
        : `Most service visits for ${plan.filters.device} ${periodLabel}: ${lines}.`;
    }
  }

  // Problem -> solution summary. Handled outside the total>0 guard:
  // a question with zero historical matches must get the honest
  // "no similar fix found" message, not a bare "0 találat" counter.
  if (plan.intent === "problem_solution") {
    return problemSolutionSummary(plan, exec.results, language);
  }

  // Phase 6: customer fleet overview. The 5-section composite is
  // always the first element of exec.results. The intent is set by
  // the answer handler after the customer probe confirms the
  // bare-name match (the router's customer_tickets_list default is
  // promoted to customer_fleet_overview when there's no leftover q).
  if (plan.intent === "customer_fleet_overview") {
    const composite = exec.results[0] as {
      customer: string;
      total: number;
      distinctMachines: number;
      topMachines: { name: string; count: number }[];
      topCategories: { name: string; count: number }[];
      last5: Array<{ sorszam?: string; reported_at_iso?: string | null }>;
      firstSeen: string | null;
      topTechnicians: { name: string; count: number }[];
    } | undefined;
    if (!composite || composite.total === 0) {
      return language === "hu"
        ? `${plan.filters.customer} ügyfélhez nem található ticket ${periodLabel}.`
        : `No tickets found for ${plan.filters.customer} ${periodLabel}.`;
    }
    // Phase 7 B1: defensive defaults. cache.stats() can return an
    // empty array, but a sub-query that throws (e.g. cross-DB call
    // hitting a missing column) previously returned undefined, which
    // crashed the .map below. The composite builder now defaults
    // missing fields to [], but keep the guards here in case a
    // future code path bypasses the builder.
    const topMachines = composite.topMachines ?? [];
    const topCategories = composite.topCategories ?? [];
    const topTechnicians = composite.topTechnicians ?? [];
    const last5 = composite.last5 ?? [];
    const machineLines = topMachines
      .map((m) => `${m.name} (${m.count})`)
      .join(", ");
    const categoryLines = topCategories
      .map((c) => `${c.name} (${c.count})`)
      .join(", ");
    const techLines = topTechnicians
      .map((t) => `${t.name} (${t.count})`)
      .join(", ");
    const ticketLines = last5
      .map((t) => `${t.sorszam ?? "?"} (${(t.reported_at_iso ?? "").slice(0, 10)})`)
      .join(", ");
    const dateRange = composite.firstSeen
      ? `${composite.firstSeen.slice(0, 10)} → ${(last5[0]?.reported_at_iso ?? "").slice(0, 10)}`
      : (last5[0]?.reported_at_iso ?? "").slice(0, 10);
    const lastTicket = last5[0];
    const lastTicketHint = lastTicket
      ? ` Legutóbbi: ${lastTicket.sorszam} (${(lastTicket.reported_at_iso ?? "").slice(0, 10)}).`
      : "";
    if (language === "hu") {
      return (
        `${composite.customer} — flotta áttekintés (${periodLabel}, ${composite.total} ticket, ${composite.distinctMachines} géptípus).\n` +
        `Gépek (top 5): ${machineLines || "—"}.\n` +
        `Hibakategóriák (top 5): ${categoryLines || "—"}.\n` +
        `Technikusok (top 3): ${techLines || "—"}.\n` +
        `Első/utolsó ticket: ${dateRange}.\n` +
        `Utolsó 5 ticket: ${ticketLines}.` +
        lastTicketHint
      );
    }
    return (
      `${composite.customer} — fleet overview (${periodLabel}, ${composite.total} tickets across ${composite.distinctMachines} machine types).\n` +
      `Top machines: ${machineLines || "—"}.\n` +
      `Top failure categories: ${categoryLines || "—"}.\n` +
      `Top technicians: ${techLines || "—"}.\n` +
      `First/most recent: ${dateRange}.\n` +
      `Last 5 tickets: ${ticketLines}.` +
      lastTicketHint
    );
  }

  // Part-spec summary. Also outside the total>0 guard: a pool with no
  // extractable spec gets the honest not-found message, never a
  // "N találat" counter.
  if (plan.intent === "part_spec") {
    return partSpecSummary(plan, exec.results, language);
  }

  if (plan.primitive === "search_tickets" && exec.total > 0) {
    // Answer attribute questions directly from the top hit's devices[]
    // / notes: "Milyen vezérlés található az M26057 gépen?" should
    // answer "Az M26057 vezérlése: ...", not "1 találat: B...".
    // Only when a device/sorszam is in play — a bare free-text search
    // ("csapágy csere") stays a list summary.
    const hasEntity = !!(plan.filters.device || plan.filters.sorszam);
    // detectAttr on the full question as fallback: the router only
    // forwards multi-token leftovers into filters.q, so a bare
    // "M26057 vezérlés" arrives with no q and would otherwise fall
    // through to the "N találat" counter instead of the direct answer.
    const attr = hasEntity ? detectAttr(plan.filters.q ?? q ?? "") : null;
    if (attr) {
      const top = exec.results[0] as any;
      const entity = plan.filters.device ?? plan.filters.sorszam ?? top?.sorszam ?? "?";
      // Scan the most recent cards for the value — the newest ticket for
      // a device may not record the attribute (controller etc.) even
      // when an older one does. Cite the card the value came from.
      let value: string | null = null;
      let srcCard: any = top;
      for (const card of (exec.results as any[]).slice(0, 8)) {
        const v = extractAttr(card, attr);
        if (v) { value = v; srcCard = card; break; }
      }
      if (value) {
        return attrSentence({
          entity,
          attr,
          value,
          source: cardSource(srcCard),
          language,
        });
      }
      // Attribute was asked but no value is recorded on the hits.
      const label = language === "hu"
        ? ({ controller: "vezérlő", software: "szoftver", hardware: "hardver", servos: "szervóhajtás", machine_type: "géptípus", model: "modell", customer: "ügyfél", status: "állapot", date: "dátum", fault: "hiba" } as Record<string, string>)[attr]
        : attr;
      return language === "hu"
        ? `${huThe(entity)} géphez nem található megadott ${label} (${exec.total} találat, az első: ${top?.sorszam ?? "?"}).`
        : `No ${label} recorded for ${entity} (${exec.total} hits, first: ${top?.sorszam ?? "?"}).`;
    }
    // Machine-history question ("Kérem az M17191 gép előéletét napjainktól
    // 2024.05.10-ig visszamenőleg") → chronological listing, not a bare
    // "N találat. Az első sorszám: X." counter.
    if (hasEntity && isHistoryRequest(q ?? plan.filters.q ?? "")) {
      return deviceHistorySummary(plan, exec.results, exec.total, periodLabel, language);
    }
    return language === "hu"
      ? `${exec.total} találat ${periodLabel}. Az első sorszám: ${(exec.results[0] as any)?.sorszam ?? "?"}.`
      : `${exec.total} matches ${periodLabel}. First sorszam: ${(exec.results[0] as any)?.sorszam ?? "?"}.`;
  }

  if (plan.intent === "top_hubs" && exec.total > 0) {
    const top = (exec.results[0] as any);
    return language === "hu"
      ? `A legtöbb más ticket által hivatkozott munka ${periodLabel}: ${top?.sorszam ?? "?"} (${top?.customer ?? "?"}, ${top?.machine ?? "?"}, ${top?.referenced_by_count ?? 0} hivatkozás).`
      : `Most-referenced work order ${periodLabel}: ${top?.sorszam ?? "?"} (${top?.customer ?? "?"}, ${top?.machine ?? "?"}, ${top?.referenced_by_count ?? 0} references).`;
  }

  if (plan.intent === "needs_clarification") {
    return language === "hu"
      ? "A kérdés túl rövid vagy túl általános. Válassz az alábbi javaslatok közül, vagy pontosítsd az ügyfél/gép/időszak szűrőt."
      : "The question is too short or too vague. Pick one of the suggestions below, or narrow down by customer / device / period.";
  }

  return language === "hu"
    ? `${exec.total} találat ${periodLabel}.`
    : `${exec.total} matches ${periodLabel}.`;
}
