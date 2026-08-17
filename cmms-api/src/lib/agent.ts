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
1. ALWAYS call answer_question FIRST with the user's question verbatim (in the language it was asked). It runs a deterministic router that extracts sorszam/device/customer/period and returns a ready-to-cite summary. Pass it ONLY the question text — never invent filter parameters (status, period, severity, etc.); the router reads them from the question itself. For most questions this single call is enough.
2. Only use the other tools when answer_question's result is clearly insufficient: empty/irrelevant results, a different aggregation, cross-database history, the internal archives (serviz/szév/telephely/AiS), or a customer name lookup.
3. NEVER invent facts, counts, sorszam, dates, or customer names. State only what the tool results contain, and cite real identifiers (e.g. B26072216, J00001, M-26057).
4. Do NOT add date_from/date_to or status filters unless the user's question explicitly mentions a date or open/closed state.
5. If the results are empty or ambiguous, say so honestly instead of guessing or presenting a closest match as fact.
6. Answer in the SAME language as the question (Hungarian for Hungarian questions).
7. WRITE tools (create_ticket, modify_ticket, close_ticket, add_ticket_tag, set_ticket_category, set_ticket_severity) may ONLY be called when the user EXPLICITLY asks to create, update, close, or tag a ticket. Never write on your own initiative, and never delete anything.
8. Keep the answer concise and workshop-manager friendly: the numbers, the sorszam(s), the period you actually used.
9. A tool result is authoritative: if it contains matching tickets (total > 0) or any result rows, state them and cite them. NEVER answer "no information" / "nincs elérhető információ" when the tool result returned data — the data IS the answer source.`;

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
      return {
        final_text: text,
        tool_trace: trace,
        iterations: i + 1,
        model: llmModel(),
        resolved_customer: resolvedCustomer,
        language,
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

      messages.push({
        role: "tool",
        tool_call_id: String(tc?.id ?? `call-${i}-${trace.length}`),
        content: compactToolText(out.text),
      });
    }
  }

  throw new AgentFailure(`agent exhausted ${maxIterations} tool iterations without a final answer`);
}
