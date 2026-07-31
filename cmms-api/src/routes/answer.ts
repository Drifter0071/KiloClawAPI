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
import { resolvePeriod, type PeriodToken } from "../lib/period";
import { routeQuestion, type RoutePlan } from "../lib/router";
import { stripHaystack } from "./shared";

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

export function answerRouter(dbs: OpenDbs, cache: JobCache): Router {
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

    // 3) Execute the plan.
    const exec = executePlan(dbs, cache, plan, q);

    // 4) Build a one-line summary in the caller's language.
    const summary = buildSummary(plan, exec, language);

    res.json({
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

function executePlan(dbs: OpenDbs, cache: JobCache, plan: RoutePlan, originalQ: string): ExecResult {
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
    const out = cache.search({
      q: plan.filters.q,
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

  if (plan.primitive === "stats") {
    const results = cache.stats({
      group_by: (plan.group_by as any) ?? "customer",
      q: plan.filters.q,
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

  // Other primitives (recurring, internal, szev, telephely, etc.) are
  // handled by the legacy endpoints. The router still gives the LLM
  // a clear `primitive` and `intent`, so the model can call the right
  // tool directly when it needs the full response. We return an empty
  // result and the rationale so the LLM can fall back to the right
  // tool.
  //
  // Phase 2: we now also execute the integration primitives
  // (find_spare_motor, get_failure_rates) directly against the
  // spec DB. The router's primitive string matches the MCP tool
  // name, so this is a one-liner dispatch.
  if (plan.primitive === "find_spare_motor") {
    return execSpareMotor(dbs, plan, period, originalQ);
  }
  if (plan.primitive === "get_failure_rates") {
    return execFailureRates(dbs, plan, period, originalQ);
  }
  return emptyExec(period, plan);
}

// ---------------------------------------------------------------------------
// Phase 2: integration primitive executors
// ---------------------------------------------------------------------------

type PeriodShape = {
  date_from: string | null;
  date_to: string | null;
  resolved_token: PeriodToken;
  label_en: string;
  label_hu: string;
};

function periodToBody(period: PeriodShape) {
  // ExecResult.period also has `token` (the requested token). We
  // don't have it here, so return null — the LLM still sees the
  // resolved window in resolved_token + date_from + date_to.
  return { token: null, ...period };
}

function execSpareMotor(
  dbs: OpenDbs,
  plan: RoutePlan,
  period: PeriodShape,
  originalQ: string,
): ExecResult {
  // Guard: telephely_ais_motor only exists after integration ETL runs.
  if (!tableExists(dbs, "telephely_ais_motor")) return emptyExec(period, plan);
  const machineSerial = plan.filters.device ?? extractMachineSerial(originalQ);
  const motorType = plan.filters.machine_type ?? extractMotorType(originalQ);
  const problema = extractProblema(originalQ);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (motorType) { where.push("tipus = ?"); params.push(motorType); }
  if (machineSerial) { where.push("melyik_gepeken_volt_ascii LIKE ?"); params.push(`%${fold(machineSerial)}%`); }
  if (problema) { where.push("problema_ascii LIKE ?"); params.push(`%${fold(problema)}%`); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = dbs.spec.query(
    `SELECT id, sorszam, tipus, gyari_szam, melyik_gepeken_volt, problema, tartozekok, megjegyzes, feladat
     FROM telephely_ais_motor ${whereSql}
     ORDER BY id ASC
     LIMIT ?`,
  ).all(...params, plan.limit ?? 20) as Record<string, unknown>[];

  // Score
  const typeQ = (motorType ?? "").toLowerCase();
  const serialQ = machineSerial ? fold(machineSerial) : "";
  const probQ = problema ? fold(problema) : "";
  const scored = rows.map((r) => {
    const tipus = String(r.tipus ?? "").toLowerCase();
    const gep = String(r.melyik_gepeken_volt ?? "").toLowerCase();
    const prob = String(r.problema ?? "").toLowerCase();
    const fel = String(r.feladat ?? "");
    let score = 0;
    if (typeQ && tipus === typeQ) score += 0.5;
    else if (typeQ && tipus.includes(typeQ)) score += 0.2;
    if (serialQ && gep.includes(serialQ)) score += 0.4;
    if (probQ && prob.includes(probQ)) score += 0.1;
    if (!fel || fel === "---") score += 0.05;
    return { ...r, match_score: +score.toFixed(2) };
  }).sort((a, b) => (b.match_score as number) - (a.match_score as number));

  return {
    total: scored.length,
    results: scored as ExecResult["results"],
    evidence: {},
    period: periodToBody(period),
  };
}

function execFailureRates(
  dbs: OpenDbs,
  plan: RoutePlan,
  period: PeriodShape,
  originalQ: string,
): ExecResult {
  // Guard: statisztika only exists after integration ETL runs.
  if (!tableExists(dbs, "statisztika")) return emptyExec(period, plan);
  // Pull product substring from the free text.
  const product = extractProductName(originalQ);
  const year = period.date_from ? new Date(period.date_from).getFullYear() : null;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (product) { where.push("kategoria_ascii LIKE ?"); params.push(`%${fold(product)}%`); }
  if (year != null) { where.push("ev = ?"); params.push(year); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const rows = dbs.spec.query(
    `SELECT ev, kategoria, hibas_db, ossz_gyartott_db, szazalek, gar_db, fiz_db
     FROM statisztika ${whereSql}
     ORDER BY szazalek DESC
     LIMIT ?`,
  ).all(...params, plan.limit ?? 20) as {
    ev: number; kategoria: string; hibas_db: number; ossz_gyartott_db: number;
    szazalek: number; gar_db: number; fiz_db: number;
  }[];

  // Compute trend (year-over-year).
  const byKey = new Map<string, { ev: number; kategoria: string; szazalek: number }>();
  for (const r of rows) byKey.set(`${r.ev}::${r.kategoria}`, r);
  const products = rows.map((r) => {
    const prev = byKey.get(`${r.ev - 1}::${r.kategoria}`);
    const trend = prev && prev.szazalek > 0 ? +(((r.szazalek - prev.szazalek) / prev.szazalek) * 100).toFixed(1) : null;
    return { ...r, trend };
  });

  return {
    total: products.length,
    results: products as ExecResult["results"],
    evidence: {},
    period: periodToBody(period),
  };
}

// Tiny extractors used by the integration executors. Pure regex,
// no LLM, deterministic. We intentionally do NOT route through
// routeQuestion again — that already happened in step 1.

function tableExists(dbs: OpenDbs, name: string): boolean {
  try {
    const r = dbs.spec.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) as { 1?: number } | null;
    return !!r;
  } catch {
    return false;
  }
}
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function extractMachineSerial(q: string): string | null {
  const m = q.match(/\bM\d{4,6}\b/i);
  return m ? m[0].toUpperCase() : null;
}
function extractMotorType(q: string): string | null {
  const m = q.match(/\b(AiS100|AiS132|Baum[uü]ller|Solpower|Mitsubishi|Fanuc|Siemens)\b/i);
  return m ? m[0] : null;
}
function extractProblema(q: string): string | null {
  const m = q.match(/\b(z[aá]rlatos|szigetel[eé]s|t[uú]z|kopott|szakadt|olvadt)\b/i);
  return m ? m[0] : null;
}
function extractProductName(q: string): string | null {
  // Look for "DxC", "IPS1-2", "IPS1", "DPB-3", etc.
  const m = q.match(/\b([A-Z]{2,5}[-]?\d{0,3}(?:[-]\d{0,3})?)\b/);
  if (!m) return null;
  const t = m[0];
  // Filter out obvious non-product matches.
  if (/^(HU|EN|OK|NR|MIN|MAX|MA|IN)$/.test(t.toUpperCase())) return null;
  return t;
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

  if (plan.intent === "find_spare_motor") {
    if (exec.total === 0) return language === "hu"
      ? "Nincs ilyen pótmotor a raktárban."
      : "No matching spare motor in stock.";
    const top = exec.results[0] as any;
    return language === "hu"
      ? `Legjobb találat: ${top.tipus ?? "?"}, ${top.melyik_gepeken_volt ?? "?"}, ${top.problema ?? "?"} (score ${top.match_score ?? "?"}). Összesen ${exec.total} motor.`
      : `Best match: ${top.tipus ?? "?"}, ${top.melyik_gepeken_volt ?? "?"}, ${top.problema ?? "?"} (score ${top.match_score ?? "?"}). ${exec.total} motors total.`;
  }

  if (plan.intent === "failure_rates") {
    if (exec.total === 0) return language === "hu"
      ? "Nincs adat a meghibásodási arányra."
      : "No failure-rate data available.";
    const worst = exec.results[0] as any;
    return language === "hu"
      ? `Legmagasabb meghibásodási arány: ${worst.kategoria} ${worst.ev}: ${worst.szazalek}% (${worst.hibas_db}/${worst.ossz_gyartott_db}).`
      : `Worst failure rate: ${worst.kategoria} ${worst.ev}: ${worst.szazalek}% (${worst.hibas_db}/${worst.ossz_gyartott_db}).`;
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
