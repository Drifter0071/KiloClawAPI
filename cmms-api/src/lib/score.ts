// Score-as-you-go layer for the answer router.
//
// The router already produces a single (intent, filters, plan) when given
// a question. This module turns that into a top-N ranking with confidence
// scores so the dashboard can either:
//
//   1. trust the top-1 (mode: "answer"), or
//   2. ask the user to pick from top-2 (mode: "confirm"), or
//   3. always offer a "Other interpretations" expander for the full top-3.
//
// Scoring formula (deterministic, no LLM, no randomness):
//
//   score = base
//         + 0.20 * entity_specificity    // sorszam > device > customer > kategoria
//         + 0.10 * min(keyword_count, 5) / 5
//         + 0.05 * question_has_date     // only bonus if intent needs a date
//         + 0.05 * period_resolved_clean
//         - 0.10 * same_family_collision  // applied to losers in the same family
//
//   base:
//     - sorszam-exact-match rule   : 0.50
//     - device + keyword rule      : 0.40
//     - customer + keyword rule    : 0.35
//     - generic stat rule          : 0.30
//     - fallthrough "search_tickets": 0.20
//
//   Intent families (used to detect same-family collisions):
//     - ticket-search : search_tickets, device_tickets_list, customer_tickets_list, find_related
//     - find-one      : find_ticket_by_sorszam
//     - stats         : top_customers, top_devices, top_machine_type, count_by_status, ...
//     - find-pattern  : find_recurring_problems, find_related_tickets
//     - integration   : search_serviz_archive, search_szev, search_telephely,
//                        find_spare_motor, failure_rates
//
// Threshold for the answer/confirm switch is configurable. We start at 0.60
// and recalibrate against the 100-question regression catalog.

import type { RoutePlan, RouteIntent, RoutePrimitive } from "./router";

export type CandidateScore = {
  rank: number;
  intent: string;
  score: number;
  score_breakdown: ScoreBreakdown;
  plan: RoutePlan;
  family: IntentFamily;
  sorszam: string | null;
  device: string | null;
  customer: string | null;
  kategoria: string | null;
  period: string | null;
  date_from: string | null;
  date_to: string | null;
};

export type ScoreBreakdown = {
  base: number;
  entity_specificity: number;
  keyword_count: number;
  keyword_contrib: number;
  has_date: number;
  has_clean_period: number;
  same_family_penalty: number;
  total: number;
};

export type IntentFamily =
  | "ticket-search"
  | "find-one"
  | "stats"
  | "find-pattern"
  | "integration"
  | "other";

export const DEFAULT_THRESHOLD = 0.60;

export function familyFor(intent: string): IntentFamily {
  if (
    intent === "search_tickets" ||
    intent === "device_tickets_list" ||
    intent === "customer_tickets_list" ||
    intent === "find_related" ||
    intent === "problem_solution" ||
    intent === "part_spec" ||
    intent === "device_top_problem" ||
    intent === "device_top_customers" ||
    intent === "device_total_count"
  ) {
    return "ticket-search";
  }
  if (intent === "find_ticket_by_sorszam") return "find-one";
  if (
    intent.startsWith("top_") ||
    intent.startsWith("count_") ||
    intent === "critical_open_now" ||
    intent === "open_count_now" ||
    intent === "customer_open_count" ||
    intent === "customer_last_seen" ||
    intent === "failure_rates" ||
    intent === "get_categories" ||
    intent === "get_tags"
  ) {
    return "stats";
  }
  if (
    intent === "find_recurring_problems" ||
    intent === "find_related_tickets" ||
    intent === "find_pattern" ||
    intent === "top_hubs"
  ) {
    return "find-pattern";
  }
  if (
    intent === "search_serviz_archive" ||
    intent === "search_szev" ||
    intent === "search_telephely" ||
    intent === "find_spare_motor"
  ) {
    return "integration";
  }
  return "other";
}

// Specificity: a sorszam match is more specific than a device match is more
// specific than a customer match is more specific than a kategoria match.
// Returns 0..1.
function entitySpecificity(plan: RoutePlan): number {
  const f = plan.filters;
  if (f.sorszam) return 1.00;
  if (f.device) return 0.80;
  if (f.customer) return 0.60;
  if (f.kategoria || f.kategoria_inferred) return 0.40;
  return 0.20;
}

function baseFor(intent: string, plan: RoutePlan): number {
  if (plan.filters.sorszam) return 0.50; // sorszam-exact-match wins
  if (plan.filters.device && plan.filters.q) return 0.40;
  if (plan.filters.customer) return 0.35;
  // stats intents start at 0.30
  if (familyFor(intent) === "stats") return 0.30;
  return 0.20; // fallthrough search
}

// Apply the formula to a single plan.
export function scoreOne(plan: RoutePlan): { score: number; breakdown: ScoreBreakdown } {
  const base = baseFor(plan.intent, plan);
  const entity = entitySpecificity(plan);
  const kw = countKeywords(plan);
  const kwContrib = 0.10 * Math.min(kw, 5) / 5;
  const hasDate = 0.05; // simplified: any time cue wins
  const hasClean = 0.05; // simplified: any period wins
  const familyPenalty = 0; // applied in rankCandidates
  const total = base + 0.20 * entity + kwContrib + hasDate + hasClean - familyPenalty;
  return {
    score: Math.max(0, Math.min(1, total)),
    breakdown: {
      base,
      entity_specificity: entity,
      keyword_count: kw,
      keyword_contrib: kwContrib,
      has_date: hasDate,
      has_clean_period: hasClean,
      same_family_penalty: familyPenalty,
      total: 0,
    },
  };
}

// Quick-and-dirty keyword count: split the q on whitespace, ignore tiny
// stopwords. Real router does its own keyword counting but we don't
// surface it; this is just for the bonus.
const STOPWORDS = new Set([
  "a", "az", "és", "is", "hogy", "egy", "ez", "azt", "ha", "meg", "már",
  "the", "and", "or", "to", "of", "in", "on", "for", "is", "are",
]);
function countKeywords(plan: RoutePlan): number {
  const q = (plan.filters.q ?? "").toLowerCase();
  if (!q) return 0;
  return q.split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)).length;
}

// Given a top-1 plan, generate plausible alternates by varying the intent.
// The alternates are deterministic and based on the same entities the
// router extracted. We do NOT call routeQuestion() again — we just clone
// the plan and substitute a related intent. This is what gives the
// "Other interpretations" expander something real to show.
export function expandPlan(top: RoutePlan): RoutePlan[] {
  const f = top.filters;
  const alternates: RoutePlan[] = [];
  const family = familyFor(top.intent);

  // Within-family alternates
  if (family === "ticket-search" && f.device) {
    if (top.intent !== "device_top_problem") {
      alternates.push({
        ...top,
        intent: "device_top_problem",
        primitive: "stats",
        group_by: "kategoria",
        rationale: "Same device, but group by problem category instead of listing tickets.",
        follow_ups: top.follow_ups,
      });
    }
    if (top.intent !== "find_related") {
      alternates.push({
        ...top,
        intent: "find_related",
        primitive: "find_related_tickets",
        rationale: "Same device, but look for related entries across serviz_belso / telephely / szev.",
        follow_ups: top.follow_ups,
      });
    }
  }
  if (family === "ticket-search" && f.customer) {
    if (top.intent !== "customer_top_devices") {
      alternates.push({
        ...top,
        intent: "customer_top_devices",
        primitive: "stats",
        group_by: "machine_type",
        rationale: "Same customer, but group by machine type instead of listing tickets.",
        follow_ups: top.follow_ups,
      });
    }
  }
  if (family === "ticket-search" && !f.device && !f.customer && !f.sorszam) {
    if (top.intent !== "top_hubs") {
      alternates.push({
        ...top,
        intent: "top_hubs",
        primitive: "top_hubs",
        rationale: "Show the most-referenced tickets (central work orders).",
        follow_ups: top.follow_ups,
      });
    }
  }
  if (family === "stats" && f.customer) {
    if (top.intent !== "customer_tickets_list") {
      alternates.push({
        ...top,
        intent: "customer_tickets_list",
        primitive: "search_tickets",
        rationale: "Same customer, but list the tickets instead of aggregating.",
        follow_ups: top.follow_ups,
      });
    }
  }
  if (family === "stats" && !f.customer && !f.device) {
    // The generic top-customers question
    if (top.intent !== "top_customers_in_period") {
      alternates.push({
        ...top,
        intent: "top_customers_in_period",
        primitive: "stats",
        group_by: "customer",
        rationale: "Same question, but ranked by ticket count over the period.",
        follow_ups: top.follow_ups,
      });
    }
  }
  return alternates;
}// Rank a list of plans, return top-N candidates with scores. Applies the
// same-family penalty to losers in each family.
//
// `plans` should be at most ~5 (one per intent family, more would be noise).
// Returns a sorted top-N list.
export function rankCandidates(
  plans: RoutePlan[],
  opts: { topN?: number; threshold?: number } = {},
): { candidates: CandidateScore[]; threshold: number } {
  const topN = opts.topN ?? 3;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  // Score all first
  const scored = plans.map((plan) => {
    const { score, breakdown } = scoreOne(plan);
    return { plan, score, breakdown, family: familyFor(plan.intent) };
  });

  // Group by family; the top scorer in each family keeps the base, the rest
  // get a -0.10 penalty.
  const byFamily = new Map<IntentFamily, typeof scored>();
  for (const s of scored) {
    const arr = byFamily.get(s.family) ?? [];
    arr.push(s);
    byFamily.set(s.family, arr);
  }
  for (const arr of byFamily.values()) {
    arr.sort((a, b) => b.score - a.score);
    for (let i = 1; i < arr.length; i++) {
      arr[i].score = Math.max(0, arr[i].score - 0.10);
      arr[i].breakdown.same_family_penalty = 0.10;
    }
  }
  // Re-flatten
  const flat: typeof scored = [];
  for (const arr of byFamily.values()) flat.push(...arr);

  // Sort by score desc, then by rank position (stable) to keep determinism
  flat.sort((a, b) => b.score - a.score || a.plan.intent.localeCompare(b.plan.intent));

  // Build the top-N candidate list
  const top = flat.slice(0, topN);
  const candidates: CandidateScore[] = top.map((s, i) => ({
    rank: i + 1,
    intent: s.plan.intent,
    score: Number(s.score.toFixed(3)),
    score_breakdown: {
      ...s.breakdown,
      total: Number(s.score.toFixed(3)),
    },
    plan: s.plan,
    family: s.family,
    sorszam: s.plan.filters.sorszam ?? null,
    device: s.plan.filters.device ?? null,
    customer: s.plan.filters.customer ?? null,
    kategoria: s.plan.filters.kategoria ?? s.plan.filters.kategoria_inferred ?? null,
    period: s.plan.period ?? null,
    date_from: null,
    date_to: null,
  }));

  return { candidates, threshold };
}
