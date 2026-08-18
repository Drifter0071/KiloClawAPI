// src/lib/agent.ts
//
// Agentic Ask loop: gpt-4o (via the Kilo Gateway) picks and calls the
// CMMS tools itself. Hybrid policy:
//   - answer_question (deterministic router) is tool #0 with a strong
//     system-prompt bias: call it FIRST. Same question → same plan for
//     unambiguous questions, so the old ~65% variance stays fixed.
//   - the other 24 tools are available for what the router can't cover.
//
// Hard-fail contract (user decision 2026-08-13): any LLM error, empty
// final answer, timeout, or iteration exhaustion throws AgentFailure —
// the route maps it to 502. There is NO deterministic fallback.
//
// Execution contract: every tool is executed as a self-fetch to the
// cmms-api REST surface (same as mcp-server.ts's call()/guardedCall()),
// with the read token for read tools and the write token for write
// tools.

import {
  AGENT_TOOLS_OPENAI,
  callAgentTool,
  V2_PARALLEL_TOOL_CALL_CAP,
  buildAgentToolsV2,
  buildAgentToolsV2OpenAI,
  v2MutateAllowed,
  type AgentToolContext,
} from "./agent_tools";
import { llmBaseUrl, llmConfigured, llmModel } from "./llm";

export const AGENT_MAX_ITERATIONS = 10;
export const AGENT_LOOP_TIMEOUT_MS = 120_000;
export const AGENT_DEFAULT_BASE_URL = "http://127.0.0.1:8787";

/** Raised on ANY agent failure (LLM error, timeout, empty answer,
 *  iteration exhaustion). The route maps this to 502 agent_failed. */
export class AgentFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFailure";
  }
}

export type AgentTraceStep = {
  name: string;
  args: unknown;
  ok: boolean;
  note?: string;
  /** v2 only: identifies one "round" of tool calls (all dispatched in
   *  parallel). Lets the dashboard render the live stream as a tree
   *  (siblings under the same group_id, synthesis node below). */
  parallel_group_id?: string;
  /** v2 only: epoch ms the tool started dispatching. */
  started_at?: number;
  /** v2 only: epoch ms the tool finished (ok or fail). */
  ended_at?: number;
};

/**
 * Slim view of a ticket surfaced to the chat as a clickable card.
 * The agent returns the full result list from answer_question; we
 * pick the fields the dashboard needs to render a card and to open
 * the existing TicketPanel on click (sorszam is the join key).
 */
export type AgentTicketCard = {
  sorszam: string;
  /** ISO 8601 — the dashboard formats it for display. */
  reported_at_iso: string | null;
  /** "open" or "closed" — drives the status badge. */
  status: "open" | "closed" | null;
  /** Customer display name (no address / phone). */
  customer_name: string | null;
  /** Primary device (machine id), when the ticket has one. */
  device: string | null;
  /** kategoria as entered by the technician (may be null). */
  kategoria: string | null;
  /** Phase 1 inferred kategoria (fills in when the human-entered one
   *  is "Egyeb" or null). */
  kategoria_inferred: string | null;
  /** Phase 1 inferred severity. */
  sulyossag_inferred: string | null;
  /** First reported note (the customer's original fault description). */
  snippet: string | null;
};

export type AgentOutcome = {
  final_text: string;
  tool_trace: AgentTraceStep[];
  iterations: number;
  model: string;
  /** Customer resolved by the deterministic router's answer_question
   *  call (if any) — feeds the SPA's per-client thread split. */
  resolved_customer: string | null;
  language: "hu" | "en";
  /**
   * When the agent's last successful answer_question call returned a
   * ticket list, we surface the full structured list here so the
   * dashboard can render clickable cards below the LLM's prose.
   * The list is NOT truncated by token budget — the LLM prose is.
   * Empty / undefined for non-list answers.
   */
  ticket_cards?: AgentTicketCard[];
  /** v2 only: true when this outcome came from runAgentV2. Helps the
   *  dashboard pick the tree visualization vs. the flat list. */
  agent_v2?: boolean;
  /** v2 only: number of distinct parallel tool-call groups used. */
  parallel_groups?: number;
};

export type AgentInput = {
  question: string;
  language: "hu" | "en";
};

export type RunAgentOptions = {
  /** Self-fetch base URL (tests inject the harness URL). Defaults to
   *  CMMS_API_URL or http://127.0.0.1:8787. */
  baseUrl?: string;
  timeoutMs?: number;
  maxIterations?: number;
};

const SYSTEM_PROMPT = `You are the CMMS assistant of a Hungarian industrial CNC controller maker and service company.
The ticket database, fault descriptions, customer names and technician notes are almost entirely in HUNGARIAN — read them as-is; never translate or "correct" sorszam, machine ids, or customer names.

TOOL DISCIPLINE:
1. ALWAYS call answer_question FIRST with the user's question VERBATIM — pass q exactly as the user wrote it, never paraphrased, shortened or translated. The router parses dates, sorszam and machine ids from the exact wording ("napjainktól 2024.05.10-ig visszamenőleg" means the 2024-05-10 → today window; rewriting it as "előélete 2024.05.10-ig" inverts the range). It returns a ready-to-cite summary. For most questions this single call is enough.
2. Only use the other tools when answer_question's result is clearly insufficient: empty/irrelevant results, a different aggregation, cross-database history, the internal archives (serviz/szév/telephely/AiS), or a customer name lookup.
3. NEVER invent facts, counts, sorszam, dates, or customer names. State only what the tool results contain, and cite real identifiers (e.g. B26072216, J00001, M-26057).
4. Do NOT add date_from/date_to or status filters unless the user's question explicitly mentions a date or open/closed state.
5. If the results are empty or ambiguous, say so honestly instead of guessing or presenting a closest match as fact.
6. Answer in the SAME language as the question (Hungarian for Hungarian questions).
7. WRITE tools (create_ticket, modify_ticket, close_ticket, add_ticket_tag, set_ticket_category, set_ticket_severity) may ONLY be called when the user EXPLICITLY asks to create, update, close, or tag a ticket. Never write on your own initiative, and never delete anything.
8. Keep the answer concise and workshop-manager friendly: the numbers, the sorszam(s), the period you actually used.
9. The answer_question result contains a summary field and top_hits. If the summary is non-empty, it IS the answer — restate it in the user's language and cite its sorszam(s). NEVER reply "no information" / "nincs elérhető információ" / "nem találtam" when the summary is non-empty or the result total is above 0; the tool result data IS the answer source. Same for every other tool: if it returned rows, report them.

LIST-ANSWER DISCIPLINE (2026-08-17, fixes truncated M17191-style history):
When answer_question returns a results list of 4+ tickets, the dashboard renders the FULL list as clickable cards automatically. Your prose is the SUMMARY only:
  - Lead with a one-sentence overview (period, total count, customer / machine).
  - Mention 1-2 highlight tickets inline by sorszam ONLY if it adds real information.
  - DO NOT enumerate every ticket in a numbered list — the cards do that.
  - End with a "Részletek lentebb" / "Details below" cue so the user knows to scroll.
For lists of 1-3 tickets, inline enumeration is still fine. For stats / aggregations (group_by), there are no cards — write the answer as before.`;

/** Answers that claim "no information" (hu + en) — the watchdog retries
 *  once when these appear despite an answer-bearing summary. */
const NO_INFO_RE =
  /(nincs elérhető információ|nincs információ|nincs informácio|nem találtam|nem talált|nem találok|nem tudom lekérdezni|nincs adat|no information|not found|cannot find|can'?t find|unable to (find|answer)|no (results?|data) found)/i;

/** Summaries that legitimately report zero results — the watchdog must
 *  NOT fire on them (the model answering "nincs találat" is correct). */
const ZERO_RESULT_RE = /(0 találat|0 eredmény|nincs találat|nem található|no results? found|nothing found)/i;

// ---------------------------------------------------------------------------
// One chat/completions round with tools
// ---------------------------------------------------------------------------

type ChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
};

type RoundResult =
  | { ok: true; data: { choices?: Array<{ message?: any }> } }
  | { ok: false; status: number; detail: string };

async function chatOnce(messages: ChatMessage[], signal: AbortSignal): Promise<RoundResult> {
  const key = (process.env.KILO_API_KEY ?? "").trim();
  if (!key) return { ok: false, status: 0, detail: "KILO_API_KEY is not configured" };
  const base = llmBaseUrl();
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: llmModel(),
        temperature: 0,
        // Output cap: gpt-4o-mini with a 1000-token cap sometimes
        // misread the (large) tool result and answered "Nincs elérhető
        // információ" even when the result contained the ticket.
        max_tokens: 2000,
        tools: AGENT_TOOLS_OPENAI,
        tool_choice: "auto",
        messages,
      }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, status: res.status, detail: detail.slice(0, 500) };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: any }> };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 0, detail: String((e as Error)?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// Tool-result compaction
// ---------------------------------------------------------------------------

/**
 * Trim a tool-result JSON string before it is sent back to the LLM.
 *
 * Why: `/v1/answer` responses carry the full customer contacts + evidence
 * blobs (multi-KB). gpt-4o-mini misread the oversized payload and replied
 * "Nincs elérhető információ" even though the result contained the ticket
 * (observed 2026-08-13 with "M26057 vezérlés"). Compacting keeps the
 * citation surface (summary, totals, filters, result rows) while bounding
 * the size. Long strings are capped, long arrays are sliced with a marker.
 * Non-JSON or small payloads pass through untouched.
 */
const TOOL_TEXT_TRIM_AT = 12_000;
const TOOL_TEXT_MAX_STRING = 400;
const TOOL_TEXT_MAX_ITEMS = 8;

function trimToolValue(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > TOOL_TEXT_MAX_STRING ? `${v.slice(0, TOOL_TEXT_MAX_STRING)}…` : v;
  }
  if (Array.isArray(v)) {
    const items = v.slice(0, TOOL_TEXT_MAX_ITEMS).map(trimToolValue);
    if (v.length > TOOL_TEXT_MAX_ITEMS) items.push(`…[+${v.length - TOOL_TEXT_MAX_ITEMS} elem]`);
    return items;
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = trimToolValue(val);
    }
    return out;
  }
  return v;
}

export function compactToolText(raw: string): string {
  if (raw.length <= TOOL_TEXT_TRIM_AT) return raw;
  try {
    const trimmed = trimToolValue(JSON.parse(raw));
    const out = JSON.stringify(trimmed);
    if (out.length < raw.length) return out;
  } catch {
    // non-JSON — fall through to the hard slice
  }
  return `${raw.slice(0, TOOL_TEXT_TRIM_AT)}\n…[csonkolva]`;
}

/**
 * answer_question digest for the LLM.
 *
 * /v1/answer's raw payload can be hundreds of KB (20 full ticket rows
 * with customer contacts + evidence blobs — the M09192 part-spec
 * question returns ~550 KB). gpt-4o-mini repeatedly misread the giant
 * JSON and answered "nem találtam információt" even though the
 * `summary` field (early in the payload) contained the full answer.
 * This collapses the payload into a small JSON whose FIRST field is
 * the ready-to-cite summary, plus a few compact evidence rows. Every
 * valid /v1/answer payload is digested (even small ones) so the LLM
 * always sees the same summary-first shape. The `filters` key is
 * preserved so the resolved-customer extraction in runAgent keeps
 * working. Non-JSON / non-answer payloads pass through untouched.
 */

/**
 * Pull the structured ticket list out of a /v1/answer payload and
 * convert it to the slim `AgentTicketCard` shape the chat UI needs.
 * Non-list answers (find_ticket_by_sorszam with one card, or empty
 * results) return [].
 *
 * Used by runAgent to populate `outcome.ticket_cards` so the
 * dashboard can render the FULL list as clickable cards, not the
 * truncated-by-token-budget list the LLM would otherwise produce
 * inline in `final_text`.
 */
export function extractTicketCardsFromAnswer(raw: string): AgentTicketCard[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const results = Array.isArray(parsed.results) ? (parsed.results as any[]) : [];
  if (results.length === 0) return [];

  const out: AgentTicketCard[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const sorszam = typeof r.sorszam === "string" ? r.sorszam : null;
    if (!sorszam) continue;
    const customerName =
      r.customer && typeof r.customer === "object" && typeof r.customer.name === "string"
        ? r.customer.name
        : null;
    const devices = Array.isArray(r.devices) ? (r.devices as any[]) : [];
    const firstDevice =
      devices.length > 0 && devices[0] && typeof devices[0].id === "string"
        ? (devices[0].id as string)
        : null;
    const notes = Array.isArray(r.notes) ? (r.notes as any[]) : [];
    const reported = notes.find((n) => n && n.kind === "reported");
    const snippet =
      reported && typeof reported.body === "string" ? reported.body : null;
    const status: "open" | "closed" | null =
      r.status === "open" || r.status === "closed" ? r.status : null;
    out.push({
      sorszam,
      reported_at_iso: typeof r.reported_at_iso === "string" ? r.reported_at_iso : null,
      status,
      customer_name: customerName,
      device: firstDevice,
      kategoria: typeof r.problem_kategoria === "string" ? r.problem_kategoria : null,
      kategoria_inferred: typeof r.kategoria_inferred === "string" ? r.kategoria_inferred : null,
      sulyossag_inferred: typeof r.sulyossag_inferred === "string" ? r.sulyossag_inferred : null,
      snippet,
    });
  }
  return out;
}

export function digestAnswerToolResult(raw: string): string {
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) return raw;
    const results = Array.isArray(j.results) ? (j.results as any[]).slice(0, 4) : [];
    const topHits = results.map((r) => {
      if (r && typeof r === "object" && "name" in r && "count" in r) {
        return { group: String(r.name), count: r.count };
      }
      const notes: Array<{ kind?: string; body?: string }> = Array.isArray(r?.notes) ? r.notes : [];
      const pick = [
        notes.find((n) => n?.kind === "work")?.body,
        notes.find((n) => n?.kind === "reported")?.body,
        notes.find((n) => n?.kind === "free")?.body,
      ].find((b) => typeof b === "string" && b.trim().length > 0);
      return {
        sorszam: r?.sorszam ?? null,
        date: r?.reported_at_iso ?? r?.reported_at ?? null,
        status: r?.status ?? null,
        customer: r?.customer?.name ?? null,
        technician: r?.technician ?? null,
        snippet: typeof pick === "string" ? pick.replace(/\s+/g, " ").trim().slice(0, 160) : null,
      };
    });
    const digest = {
      summary: typeof j.summary === "string" ? j.summary : null,
      intent: typeof j.intent === "string" ? j.intent : null,
      primitive: typeof j.primitive === "string" ? j.primitive : null,
      mode: typeof j.mode === "string" ? j.mode : null,
      filters: j.filters ?? null,
      period: j.period ?? null,
      total: typeof j.total === "number" ? j.total : null,
      top_hits: topHits,
      follow_ups: Array.isArray(j.follow_ups) ? (j.follow_ups as string[]).slice(0, 3) : [],
    };
    const out = JSON.stringify(digest);
    return out;
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// runAgent — the loop
// ---------------------------------------------------------------------------

export async function runAgent(
  input: AgentInput,
  opts: RunAgentOptions = {},
): Promise<AgentOutcome> {
  if (!llmConfigured()) {
    throw new AgentFailure("KILO_API_KEY is not configured");
  }
  const language: "hu" | "en" = input.language === "en" ? "en" : "hu";
  const maxIterations = opts.maxIterations ?? AGENT_MAX_ITERATIONS;
  const deadline = Date.now() + (opts.timeoutMs ?? AGENT_LOOP_TIMEOUT_MS);

  const envBase = (process.env.CMMS_API_URL ?? "").trim();
  const ctx: AgentToolContext = {
    baseUrl: opts.baseUrl ?? (envBase || AGENT_DEFAULT_BASE_URL),
    readToken: process.env.CMMS_API_TOKEN_READ ?? "",
    writeToken: process.env.CMMS_API_TOKEN_WRITE ?? "",
  };

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: input.question },
  ];
  const trace: AgentTraceStep[] = [];
  let resolvedCustomer: string | null = null;
  // No-info watchdog: gpt-4o-mini occasionally ignores a non-empty
  // deterministic summary and answers "nincs elérhető információ".
  // When answer_question returned an answer-bearing summary and the
  // model still claims no info, inject the summary and retry once.
  // If answer_question never succeeded (bypassed or failed) and the
  // model claims no info, nudge it to call the router FIRST with the
  // verbatim question and retry once.
  let noInfoRetried = false;
  let lastAnswerSummary: string | null = null;
  let answerQuestionSucceeded = false;
  // Structured ticket list from the last successful answer_question
  // call. The dashboard renders this as cards below the LLM's prose,
  // so the LLM never has to enumerate >4 items in `final_text`.
  let ticketCards: AgentTicketCard[] | null = null;

  for (let i = 0; i < maxIterations; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AgentFailure(`agent loop timed out after ${opts.timeoutMs ?? AGENT_LOOP_TIMEOUT_MS}ms`);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    let round: RoundResult;
    try {
      round = await chatOnce(messages, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    if (!round.ok) {
      const detail = round.detail ? `: ${round.detail}` : ` (HTTP ${round.status})`;
      throw new AgentFailure(`LLM request failed${detail}`);
    }

    const message = round.data.choices?.[0]?.message;
    if (!message) throw new AgentFailure("LLM response had no choices[0].message");

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      const text = typeof message.content === "string" ? message.content.trim() : "";
      if (text.length === 0) throw new AgentFailure("LLM returned an empty final answer");
      if (!noInfoRetried && NO_INFO_RE.test(text)) {
        if (lastAnswerSummary) {
          noInfoRetried = true;
          console.log(JSON.stringify({ t: new Date().toISOString(), msg: "agent_watchdog_summary", summary: lastAnswerSummary.slice(0, 220) }));
          messages.push({
            role: "user",
            content:
              language === "hu"
                ? `A fenti tool eredmény TARTALMAZTA a választ. NE válaszolj "nincs információ"-val — fogalmazd át a következő determinisztikus választ: ${lastAnswerSummary}`
                : `The tool result above CONTAINED the answer. Do NOT reply "no information" — rewrite this deterministic answer: ${lastAnswerSummary}`,
          });
          continue;
        }
        if (!answerQuestionSucceeded) {
          noInfoRetried = true;
          console.log(JSON.stringify({ t: new Date().toISOString(), msg: "agent_watchdog_tool_discipline", q: input.question.slice(0, 120) }));
          messages.push({
            role: "user",
            content:
              language === "hu"
                ? `Ne válaszolj "nincs információ"-val még. Hívd meg ELŐSZÖR az answer_question eszközt, a kérdés pontos szövegével: ${input.question}`
                : `Don't answer "no information" yet. Call the answer_question tool FIRST, passing the question verbatim: ${input.question}`,
          });
          continue;
        }
      }
      return {
        final_text: text,
        tool_trace: trace,
        iterations: i + 1,
        model: llmModel(),
        resolved_customer: resolvedCustomer,
        language,
        ...(ticketCards ? { ticket_cards: ticketCards } : {}),
      };
    }

    // Execute the tool calls, then hand the results back to the model.
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let name = "";
      let argsRaw = "{}";
      if (tc && typeof tc.function === "object" && tc.function !== null) {
        name = String(tc.function.name ?? "");
        if (typeof tc.function.arguments === "string") argsRaw = tc.function.arguments;
      }
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argsRaw || "{}") as Record<string, unknown>;
      } catch {
        args = { _raw: argsRaw };
      }

      const out = await callAgentTool(name, args, ctx);
      trace.push({ name, args, ok: out.ok, note: out.note });

      // The router's resolved customer (from answer_question) drives the
      // SPA's per-client chat threads.
      if (name === "answer_question" && resolvedCustomer === null && out.ok) {
        try {
          const parsed = JSON.parse(out.text) as { filters?: { customer?: unknown } };
          const c = parsed?.filters?.customer;
          if (typeof c === "string" && c.trim().length > 0) resolvedCustomer = c.trim();
        } catch {
          // non-JSON error text — leave resolvedCustomer null
        }
      }

      const content =
        name === "answer_question" && out.ok ? compactToolText(digestAnswerToolResult(out.text)) : compactToolText(out.text);
      if (name === "answer_question" && out.ok) {
        answerQuestionSucceeded = true;
        // Capture the full structured ticket list from the raw /v1/answer
        // payload BEFORE we digest it for the LLM. The dashboard uses
        // this to render the list as cards; the LLM only sees a tiny
        // summary-first digest. Replace any previous list so the FINAL
        // answer_question call wins.
        const cards = extractTicketCardsFromAnswer(out.text);
        if (cards.length > 0) ticketCards = cards;
        try {
          const parsed = JSON.parse(content) as { summary?: unknown };
          const s = typeof parsed?.summary === "string" ? parsed.summary.trim() : "";
          if (s.length > 0 && !ZERO_RESULT_RE.test(s)) lastAnswerSummary = s;
          // Ops visibility: what the model actually received, so "no info"
          // complaints can be traced without re-running the whole flow.
          console.log(
            JSON.stringify({
              t: new Date().toISOString(),
              msg: "agent_answer_digest",
              q: input.question.slice(0, 120),
              summary_len: s.length,
              summary: s.slice(0, 220),
              watchdog_armed: lastAnswerSummary !== null,
            }),
          );
        } catch {
          // non-JSON digest passthrough — the watchdog just stays off
        }
      }
      messages.push({
        role: "tool",
        tool_call_id: String(tc?.id ?? `call-${i}-${trace.length}`),
        // answer_question returns a digest (summary first) so the LLM
        // cannot misread the giant /v1/answer payload; everything else
        // goes through the generic compaction.
        content,
      });
    }
  }

  throw new AgentFailure(`agent exhausted ${maxIterations} tool iterations without a final answer`);
}

// ===========================================================================
// v2 — Option 2: LLM composes the answer from raw evidence, parallel tools
// ===========================================================================
//
// Architectural inversion of v1:
//   - Tool surface is curated (~8 read + gated mutate), not 26.
//   - answer_question is NOT in the registry. The LLM is the reasoner.
//   - Multiple tool calls per turn run in parallel (Promise.all).
//   - Hard cap of V2_PARALLEL_TOOL_CALL_CAP per turn to keep the model
//     from fishing.
//   - CMMS-only scope is enforced by ABSENCE from the tool surface
//     (cookie recipes, web, file system are unreachable), not by a
//     "please refuse" line in the prompt.
//   - No-info watchdog is preserved (same NO_INFO_RE / ZERO_RESULT_RE),
//     so the same flakiness mitigations that fixed v1 still fire here.

const SYSTEM_PROMPT_V2 = `You are the CMMS assistant of a Hungarian industrial CNC controller maker and service company.
The ticket database, fault descriptions, customer names and technician notes are almost entirely in HUNGARIAN — read them as-is; never translate or "correct" sorszam, machine ids, or customer names.

WHAT YOU DO
You answer the user's question by calling the tools and reasoning across the results. You write the final answer yourself in the user's language (Hungarian for Hungarian questions, English for English questions).

TOOL KIT
- find_ticket(sorszam) — known ticket number, returns the full card
- search_tickets(q, customer, device, sorszam, status, kategoria, period, limit)
  — open-ended question, or to verify a hypothesis
- get_device_history(device) — all tickets ever for one device
- find_related_tickets(sorszam or customer+device) — full timeline across all 4 DBs
- get_ticket_stats(group_by, period, ...) — counts, top-N, aggregations
- list_customers(query) — name lookup, per-customer counts
- find_spare_motor(serial, motor_type, problem) — replacement motor
- find_linkage(sorszam, direction) — "which other tickets reference this one"

RULES
1. ALWAYS use the tools. Never answer from general knowledge. If a tool returned rows, report them.
2. PREFER calling 2–5 tools in PARALLEL when the question has multiple facets. Example: "is this device problematic" → search_tickets for the device + get_device_history + get_failure_rates in one turn. The loop will dispatch them concurrently; you'll get all the results back together.
3. CITE real sorszams. Never invent ticket numbers. If a tool returned 0 hits, say so honestly.
4. DO NOT add filters the user did not ask for. In particular:
   - Do NOT add status="open" or status="closed" unless the user says "nyitott" / "lezárt" / "open" / "closed".
   - Do NOT add period="this_year" / "tavaly" / "utolsó 30 nap" unless the user mentions a time range.
   - Do NOT add date_from / date_to unless the user names a specific date.
   - Do NOT add sulyossag_inferred or kategoria_inferred unless the user asks for severity or category filtering.
   Default to NO filters — let the tool return all matching rows, then narrow if needed.
5. When the question is ambiguous, ask a follow-up.
6. If the user asks something outside CMMS, refuse briefly and offer a CMMS-relevant reframing. Do not attempt to answer off-topic questions even if you "know" the answer.
7. Keep the answer concise and workshop-manager friendly: the numbers, the sorszam(s), the period you actually used. 1–4 sentences for simple lookups, longer only for genuine synthesis.

OUTPUT FORMAT
- Plain prose in the user's language (hu or en).
- Bullet the cited sorszams (e.g. "B26071801 (PLASMA-TECH, 2026-07-18)").
- Do NOT enumerate every ticket in a numbered list — if you pulled 8 rows, summarize and let the user see the list below.

WHAT YOU DO NOT HAVE
- No web access. No file system. No general knowledge. Your tool surface IS your scope. Off-topic questions are answered with a one-sentence refusal and a CMMS-relevant reframe.`;

export type RunAgentV2Options = RunAgentOptions & {
  /** Override the mutate gate (defaults to env ASK_AGENT_ALLOW_MUTATE). */
  allowMutate?: boolean;
  /** Override the per-turn parallel cap (defaults to V2_PARALLEL_TOOL_CALL_CAP). */
  parallelCap?: number;
  /** Pre-curated toolset (output of curateV2Toolset). When provided,
   *  the model only sees these tools; otherwise the full 8-tool v2
   *  surface is shown. */
  curatedToolset?: { tools: string[]; primary: string; fallbacks: string[]; assignment: string; suggestedArgs: Record<string, Record<string, unknown>> };
};

/** v2 entry point. Same return shape as runAgent, plus agent_v2 + parallel_groups. */
export async function runAgentV2(
  input: AgentInput,
  opts: RunAgentV2Options = {},
): Promise<AgentOutcome> {
  if (!llmConfigured()) {
    throw new AgentFailure("KILO_API_KEY is not configured");
  }
  const language: "hu" | "en" = input.language === "en" ? "en" : "hu";
  const maxIterations = opts.maxIterations ?? AGENT_MAX_ITERATIONS;
  const deadline = Date.now() + (opts.timeoutMs ?? AGENT_LOOP_TIMEOUT_MS);
  const allowMutate = opts.allowMutate ?? v2MutateAllowed();
  const parallelCap = opts.parallelCap ?? V2_PARALLEL_TOOL_CALL_CAP;
  const curated = opts.curatedToolset;

  const envBase = (process.env.CMMS_API_URL ?? "").trim();
  const ctx: AgentToolContext = {
    baseUrl: opts.baseUrl ?? (envBase || AGENT_DEFAULT_BASE_URL),
    readToken: process.env.CMMS_API_TOKEN_READ ?? "",
    writeToken: process.env.CMMS_API_TOKEN_WRITE ?? "",
    toolsAllowMutate: allowMutate,
  };
  // State-aware tool surface: when the route plan is provided, we show
  // the LLM only the 2-4 tools the deterministic router picked. Without
  // a route plan, fall back to the full 8-tool v2 surface.
  const { buildAgentToolsV2Subset, buildAgentToolsV2SubsetOpenAI } = await import("./agent_tools");
  const toolset = curated
    ? buildAgentToolsV2Subset(curated.tools, { allowMutate })
    : buildAgentToolsV2({ allowMutate });
  const toolsOpenAi = curated
    ? buildAgentToolsV2SubsetOpenAI(curated.tools, { allowMutate })
    : buildAgentToolsV2OpenAI({ allowMutate });
  const knownNames = new Set(toolset.map((t) => t.name));
  // Wire the v2 toolset into the executor so callAgentTool can find
  // V2_ONLY_TOOL_DEFS entries (find_ticket, get_device_history,
  // list_customers) that don't exist in AGENT_TOOLS.
  ctx.toolset = toolset;

  // System prompt: append the router's assignment sentence when a
  // curated toolset is in play, so the LLM knows exactly which tool
  // to start with and which fallbacks to use.
  const sysPrompt =
    curated
      ? SYSTEM_PROMPT_V2 +
        "\n\nROUTER ASSIGNMENT (deterministic, do not ignore):\n" +
        curated.assignment +
        (Object.keys(curated.suggestedArgs).length > 0
          ? "\n\nSUGGESTED STARTING ARGS (verbatim — you may keep or override, but do NOT invent filter fields not listed here):\n" +
            Object.entries(curated.suggestedArgs)
              .map(([t, a]) => `- ${t}: ${JSON.stringify(a)}`)
              .join("\n")
          : "")
      : SYSTEM_PROMPT_V2;

  const messages: ChatMessage[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: input.question },
  ];
  const trace: AgentTraceStep[] = [];
  let parallelGroups = 0;
  // v2 doesn't have a resolved_customer from a router (no answer_question).
  // We DO extract it from the first successful search_tickets / find_ticket
  // / get_ticket_stats call so the SPA's per-client thread split still works.
  let resolvedCustomer: string | null = null;
  let noInfoRetried = false;

  for (let i = 0; i < maxIterations; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AgentFailure(`agent loop timed out after ${opts.timeoutMs ?? AGENT_LOOP_TIMEOUT_MS}ms`);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    let round: RoundResult;
    try {
      // v2 uses the curated toolset, not the full 26.
      round = await chatOnceWithTools(messages, toolsOpenAi, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    if (!round.ok) {
      const detail = round.detail ? `: ${round.detail}` : ` (HTTP ${round.status})`;
      throw new AgentFailure(`LLM request failed${detail}`);
    }

    const message = round.data.choices?.[0]?.message;
    if (!message) throw new AgentFailure("LLM response had no choices[0].message");

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      const text = typeof message.content === "string" ? message.content.trim() : "";
      if (text.length === 0) throw new AgentFailure("LLM returned an empty final answer");
      // No-info watchdog: same logic as v1 but no answer_question summary
      // to inject. The nudge asks the model to call a tool, not to rewrite.
      if (!noInfoRetried && NO_INFO_RE.test(text)) {
        noInfoRetried = true;
        console.log(JSON.stringify({ t: new Date().toISOString(), msg: "agent_v2_watchdog", q: input.question.slice(0, 120) }));
        messages.push({
          role: "user",
          content:
            language === "hu"
              ? `Ne válaszolj "nincs információ"-val. Hívd meg a megfelelő eszközt (search_tickets / find_ticket / get_device_history / list_customers) a kérdés szövegével vagy egy konkrét sorszámmal / ügyfélnévvel / géppel. Ha valóban nincs adat, azt írd: "0 találat" + miért kerestél.`
              : `Don't answer "no information". Call the right tool (search_tickets / find_ticket / get_device_history / list_customers) with the question or a specific sorszam / customer / device. If there is genuinely no data, say "0 results" + what you searched.`,
        });
        continue;
      }
      return {
        final_text: text,
        tool_trace: trace,
        iterations: i + 1,
        model: llmModel(),
        resolved_customer: resolvedCustomer,
        language,
        agent_v2: true,
        parallel_groups: parallelGroups,
      };
    }

    // Cap the number of tool calls per turn: anything over parallelCap is
    // a model that's fishing. Take the first N, nudge the rest.
    let dropped = 0;
    let dispatched = toolCalls;
    if (toolCalls.length > parallelCap) {
      dropped = toolCalls.length - parallelCap;
      dispatched = toolCalls.slice(0, parallelCap);
    }
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });

    // Build the per-call context. Anything that wasn't in the curated
    // toolset (a hallucinated name) gets a clean refusal before dispatch.
    const plan = dispatched.map((tc: any) => {
      let name = "";
      let argsRaw = "{}";
      if (tc && typeof tc.function === "object" && tc.function !== null) {
        name = String(tc.function.name ?? "");
        if (typeof tc.function.arguments === "string") argsRaw = tc.function.arguments;
      }
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argsRaw || "{}") as Record<string, unknown>;
      } catch {
        args = { _raw: argsRaw };
      }
      return { tc, name, args, rawId: String(tc?.id ?? `call-${i}-${trace.length + 1}`) };
    });
    const groupId = `g${i}`;
    parallelGroups += 1;
    const groupStart = Date.now();
    const results = await Promise.all(
      plan.map(async (p: { name: string; args: Record<string, unknown>; tc: any; rawId: string }) => {
        const start = Date.now();
        // Hallucinated tool name: refuse in-band rather than throwing.
        if (!knownNames.has(p.name)) {
          return {
            p,
            start,
            end: Date.now(),
            out: { ok: false, text: `Unknown tool: "${p.name}". Available tools: ${Array.from(knownNames).join(", ")}.`, note: "unknown_tool" as string | undefined },
          };
        }
        const out = await callAgentTool(p.name, p.args, ctx);
        return { p, start, end: Date.now(), out };
      }),
    );

    // Walk results in the original tool_call order so the dashboard's
    // tree renders left-to-right matching the model's intent.
    for (const r of results) {
      const { p, out, start, end } = r as { p: { name: string; args: Record<string, unknown>; tc: any }; out: { ok: boolean; text: string; note?: string }; start: number; end: number };
      trace.push({
        name: p.name,
        args: p.args,
        ok: out.ok,
        note: out.note,
        parallel_group_id: groupId,
        started_at: start,
        ended_at: end,
      });

      // v2 resolved-customer extraction: pull a customer name out of the
      // first successful relevant call so the SPA per-client thread split
      // still works. We accept it from search_tickets, find_ticket, and
      // get_ticket_stats responses.
      if (resolvedCustomer === null && out.ok && (p.name === "search_tickets" || p.name === "find_ticket" || p.name === "get_ticket_stats" || p.name === "list_customers")) {
        try {
          const parsed = JSON.parse(out.text) as { customer?: unknown; filters?: { customer?: unknown }; results?: Array<{ customer?: unknown; customer_name?: unknown }> };
          let c: unknown = parsed?.filters?.customer ?? parsed?.customer;
          if (!c && Array.isArray(parsed?.results) && parsed.results.length > 0) {
            c = parsed.results[0]?.customer ?? parsed.results[0]?.customer_name;
          }
          if (typeof c === "string" && c.trim().length > 0) resolvedCustomer = c.trim();
        } catch {
          // non-JSON or missing — leave resolvedCustomer null
        }
      }
    }

    // Feed results back to the model in tool_calls order, with the
    // standard compactToolText pass on every payload.
    for (const r of results) {
      const { p, out } = r;
      const content = compactToolText(out.text);
      messages.push({
        role: "tool",
        tool_call_id: String(p.tc?.id ?? `call-${i}-${trace.length}`),
        content,
      });
    }

    // If we dropped any tool calls this turn, append a system nudge so
    // the model knows the dropped ones were intentionally ignored.
    if (dropped > 0) {
      const droppedNames = toolCalls.slice(parallelCap).map((tc: any) => String(tc?.function?.name ?? "?"));
      messages.push({
        role: "user",
        content:
          language === "hu"
            ? `(A rendszer ${dropped} további párhuzamos hívást figyelmen kívül hagyott, mert a turn korlátja ${parallelCap}: ${droppedNames.join(", ")}. Ha kell valamelyik, hívd a következő körben.)`
            : `(The system dropped ${dropped} additional parallel calls (per-turn cap ${parallelCap}): ${droppedNames.join(", ")}. If you need any of them, call again next turn.)`,
      });
    }
    // Touch groupStart so the linter doesn't drop the variable; useful
    // for future wall-time accounting.
    void groupStart;
  }

  throw new AgentFailure(`agent exhausted ${maxIterations} tool iterations without a final answer`);
}

/** v2 chat/completions call: same shape as chatOnce but takes a tools array
 *  so the v2 curated subset can be passed in directly. */
async function chatOnceWithTools(
  messages: ChatMessage[],
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } } }>,
  signal: AbortSignal,
): Promise<RoundResult> {
  const key = (process.env.KILO_API_KEY ?? "").trim();
  if (!key) return { ok: false, status: 0, detail: "KILO_API_KEY is not configured" };
  const base = llmBaseUrl();
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: llmModel(),
        temperature: 0,
        // v2: a bit more headroom than v1 — the model has to write
        // synthesis prose in addition to picking tools, and parallel
        // results are longer than answer_question's digest.
        max_tokens: 2500,
        tools,
        tool_choice: "auto",
        messages,
      }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, status: res.status, detail: detail.slice(0, 500) };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: any }> };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 0, detail: String((e as Error)?.message ?? e) };
  }
}
