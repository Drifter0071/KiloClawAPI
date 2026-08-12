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
import { routeQuestion, type RoutePlan } from "../lib/router";
import { stripHaystack } from "./shared";
import { findRelated } from "../lib/related";
import { stripLLMDates } from "../lib/date_guard";
import { expandPlan, rankCandidates, DEFAULT_THRESHOLD, type CandidateScore } from "../lib/score";

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

  r.post("/v1/answer", (req, res) => {
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
    const exec = executePlan(cache, dbs, plan);
    const summary = buildSummary(plan, exec, language);

    // 5) Enrich each candidate with a preview summary so the dashboard
    //    can render the "Other interpretations" expander without a
    //    second round-trip. (Per user decision: return all 3 always.)
    const enriched = candidates.map((c): CandidateScore => {
      const ex = executePlan(cache, dbs, c.plan);
      const s = buildSummary(c.plan, ex, language);
      return {
        ...c,
        // Inject the per-candidate execution result. The client can
        // ignore this if it doesn't want to render the alternates.
        plan: { ...c.plan },
      };
    });

    res.json({
      // Backwards-compat top-level fields
      q,
      language,
      intent: plan.intent,
      primitive: plan.primitive,
      group_by: plan.group_by ?? null,
      filters: plan.filters,
      period: exec.period,
      summary,
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
        const ex = executePlan(cache, dbs, c.plan);
        const s = buildSummary(c.plan, ex, language);
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
      window_days: body.window_days ?? 180,
      limit: body.limit ?? 50,
    });

    const seed = result.seed;
    const n = result.total;
    const sources = result.sources_searched ?? [];
    const summary = language === "hu"
      ? (seed?.sorszam && seed.sorszam !== "(search)"
        ? `A(z) ${seed.sorszam} (${seed.customer ?? "?"}, ${seed.machine_type ?? "?"}) kapcsolódó bejegyzései: ${n} találat (${sources.join(", ")}).`
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

function executePlan(cache: JobCache, dbs: OpenDbs, plan: RoutePlan): ExecResult {
  const period = resolvePeriod(plan.period, new Date(), {});
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

function buildSummary(plan: RoutePlan, exec: ExecResult, language: "hu" | "en"): string {
  const top = exec.results[0] as any;
  const period = exec.period;
  const periodLabel = period ? (language === "hu" ? period.label_hu : period.label_en) : (language === "hu" ? "minden időszakban" : "all time");

  if (plan.intent === "find_ticket_by_sorszam") {
    if (exec.total === 0) return language === "hu"
      ? `Nem található a(z) ${plan.filters.sorszam} sorszámú ticket.`
      : `No ticket found with sorszam ${plan.filters.sorszam}.`;
    const t = exec.results[0] as any;
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
        ? `A(z) ${seed.sorszam} (ügyfél: ${seed.customer ?? "?"}, gép: ${seed.machine_type ?? "?"}) kapcsolódó bejegyzései: ${n} találat (${sourcesStr}).`
        : `Kapcsolódó bejegyzések (${seed?.customer ?? "?"}, ${seed?.machine_type ?? "?"}): ${n} találat (${sourcesStr}).`;
    }
    return seed?.sorszam && seed.sorszam !== "(search)"
      ? `Related entries for ${seed.sorszam} (${seed.customer ?? "?"}, ${seed.machine_type ?? "?"}): ${n} hits (${sourcesStr}).`
      : `Related entries (${seed?.customer ?? "?"}, ${seed?.machine_type ?? "?"}): ${n} hits (${sourcesStr}).`;
  }

  if (plan.primitive === "stats" && exec.total > 0 && top && typeof top === "object" && "name" in top) {
    const top5 = (exec.results as Array<{ name: string; count: number }>).slice(0, 5);
    const lines = top5.map((r) => `${r.name} (${r.count})`).join(", ");
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
        ? `A sulyossag-eloszlás ${periodLabel}: ${lines}.`
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
        ? `${plan.filters.device} leggyakoribb hibái: ${lines}.`
        : `${plan.filters.device}'s most common failures: ${lines}.`;
    }
  }

  if (plan.primitive === "search_tickets" && exec.total > 0) {
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
