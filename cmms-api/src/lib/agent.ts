// src/lib/agent.ts
//
// Agentic Ask loop: openai/gpt-5.6-luna-pro (via the Kilo Gateway)
// picks and calls the CMMS tools itself. Hybrid policy:
//   - answer_question (deterministic router) is tool #0 with a strong
//     system-prompt bias: call it FIRST. Same question → same plan for
//     unambiguous questions, so the old ~65% variance stays fixed.
//   - the other 24 tools are available for what the router can't cover.
//
// Hard-fail contract (user decision 2026-08-13): any LLM error, empty
// final answer, timeout, or iteration exhaustion throws AgentFailure —
// the route maps it to 502. There is NO deterministic fallback.
//
// Soft deadline (2026-08-19): the dashboard is fronted by the zrok edge,
// which cuts proxied responses around ~60s. Hard questions used to run
// 60-124s and die with a 504 for the browser. Once the loop has been
// running past AGENT_SOFT_DEADLINE_MS we append a forced-synthesis system
// message and set tool_choice "none", so the model must write its final
// answer from the evidence gathered so far. This is NOT a failure path —
// it bounds the tail without a deterministic fallback.
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

// Crockford-base32 ULID. Monotonic-ish: timestamp prefix + 80 random
// bits, lowercase. We don't need true monotonicity here (one answer
// per agent run, not millions/sec), so a fresh per-call value is
// fine. Output is 26 chars, URL-safe.
const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
function newUlid(): string {
  const now = Date.now()
  let ts = now
  let tsPart = ""
  for (let i = 9; i >= 0; i -= 1) {
    tsPart = ULID_ALPHABET[ts % 32] + tsPart
    ts = Math.floor(ts / 32)
  }
  let randPart = ""
  const bytes = new Uint8Array(16)
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  // 80 random bits → 16 base32 chars.
  for (let i = 0; i < 16; i += 1) {
    const byte = bytes[i] ?? 0
    randPart += ULID_ALPHABET[byte % 32]
  }
  return tsPart + randPart
}

export const AGENT_MAX_ITERATIONS = 10;
export const AGENT_LOOP_TIMEOUT_MS = 120_000;
// Soft deadline for the whole agent run: once elapsed time crosses this,
// the next LLM round is forced to synthesize a final answer (tool_choice
// "none"). Keeps hard questions inside the zrok edge's ~60s response
// window instead of dying with a 504. Env-tunable: AGENT_SOFT_DEADLINE_MS.
// 45s was too late: the forced final synthesis call itself takes ~15-20s
// (large accumulated context), so 45+20=65s still got cut by the edge at
// 60.2s (observed 2026-08-19). 35s leaves the final call a ~25s budget.
export const AGENT_SOFT_DEADLINE_MS = 35_000;
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
  /** Stable ULID stamped on the final answer. The agent route inserts
   *  a feedback_answers row keyed by this id so the SPA can attach a
   *  like/dislike vote (or a free-text correction) to a specific
   *  response. Re-runs of the same answer over-write the row but
   *  keep the same id (so vote counts stay attached to the answer's
   *  current text). */
  answer_id: string;
  /** True when the soft deadline forced the model to synthesize its
   *  final answer from the evidence gathered so far (the loop did NOT
   *  hit the hard timeout — the answer is still complete, just
   *  produced under time pressure). Lets ops see how often the edge
   *  window is the binding constraint. */
  soft_deadline_forced: boolean;
};

export type AgentHistoryTurn = {
  role: "user" | "assistant";
  text: string;
};

/** Client-supplied default scope (machine-scoped ask / same-thread
 *  context). Injected as a system message BETWEEN the base prompt and
 *  the history: "use this as the default scope, the user's own wording
 *  takes precedence". */
export type AgentContextScope = {
  device?: string;
  customer?: string;
  sorszam?: string;
};

export type AgentInput = {
  question: string;
  language: "hu" | "en";
  /** Prior turns from the SPA's active chat thread (max 12, server
   *  trims; text ≤ 2000 chars per turn). Lets follow-ups like
   *  "és a másik gép?" resolve against the earlier exchange. */
  history?: AgentHistoryTurn[];
  /** Machine-scoped ask: the device/customer/sorszam the user picked
   *  BEFORE asking, applied as a default scope for the whole run. */
  context?: AgentContextScope;
};

export type RunAgentOptions = {
  /** Self-fetch base URL (tests inject the harness URL). Defaults to
   *  CMMS_API_URL or http://127.0.0.1:8787. */
  baseUrl?: string;
  timeoutMs?: number;
  maxIterations?: number;
  /** Wall-clock soft deadline for the whole run. After this many ms
   *  the loop forces a final answer (see AGENT_SOFT_DEADLINE_MS). */
  softDeadlineMs?: number;
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
// Shared prompt assembly: system → context scope → history → question.
// ---------------------------------------------------------------------------

const HISTORY_MAX_TURNS = 12;
const HISTORY_MAX_TEXT = 2000;
const CONTEXT_MAX_LEN = 200;

function buildMessages(input: AgentInput): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  const ctx = input.context ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ctx) as [keyof AgentContextScope, string | undefined][]) {
    const val = typeof v === "string" ? v.trim().slice(0, CONTEXT_MAX_LEN) : "";
    if (val.length > 0) parts.push(`${k}: ${val}`);
  }
  if (parts.length > 0) {
    messages.push({
      role: "system",
      content:
        `SCOPE: the user is asking about ${parts.join(", ")}. ` +
        `Use this as the DEFAULT scope for tool calls, but the user's own ` +
        `wording in the question takes precedence.`,
    });
  }

  const history = Array.isArray(input.history) ? input.history.slice(-HISTORY_MAX_TURNS) : [];
  for (const h of history) {
    const role = h.role === "assistant" ? "assistant" : "user";
    const text = String(h.text ?? "").slice(0, HISTORY_MAX_TEXT);
    if (text.length === 0) continue;
    messages.push({ role, content: text });
  }

  messages.push({ role: "user", content: input.question });
  return messages;
}

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

async function chatOnce(
  messages: ChatMessage[],
  signal: AbortSignal,
  toolChoice: "auto" | "none" = "auto",
  omitTools = false,
): Promise<RoundResult> {
  const key = (process.env.KILO_API_KEY ?? "").trim();
  if (!key) return { ok: false, status: 0, detail: "KILO_API_KEY is not configured" };
  const base = llmBaseUrl();
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  try {
    const body: Record<string, unknown> = {
      model: llmModel(),
      temperature: 0,
      // 2026-08-19: bumped from 2000 → 8192. The old cap truncated
      // comprehensive answers mid-sentence (e.g. 12-ticket history
      // summaries). gpt-5.6-luna-pro can output up to 16K tokens.
      max_tokens: 8192,
      messages,
    };
    // The soft-deadline forced round ships WITHOUT the tool list at
    // all: the model cannot emit tool_calls, the prompt is smaller
    // (faster prefill), and tool_choice semantics can't be ignored.
    if (!omitTools) {
      body.tools = AGENT_TOOLS_OPENAI;
      body.tool_choice = toolChoice;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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
// Streaming chat/completions round (SSE)
//
// Same request as chatOnce but `stream: true`. Parses the SSE frame
// stream incrementally:
//   - content deltas are forwarded through `onContent` ONLY while the
//     round has emitted no tool_calls delta (tool rounds buffer their
//     preamble text silently — it is model "thinking", not the answer);
//   - tool_calls deltas are accumulated per `index` until the stream
//     ends, then returned as a normal message.tool_calls array so the
//     loop below can execute them exactly like the non-stream path.
// ---------------------------------------------------------------------------

type StreamToolFragment = { id: string; name: string; args: string };

async function chatOnceStream(
  messages: ChatMessage[],
  signal: AbortSignal,
  onContent: (delta: string) => void,
  toolChoice: "auto" | "none" = "auto",
  omitTools = false,
): Promise<RoundResult> {
  const key = (process.env.KILO_API_KEY ?? "").trim();
  if (!key) return { ok: false, status: 0, detail: "KILO_API_KEY is not configured" };
  const base = llmBaseUrl();
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  try {
    const body: Record<string, unknown> = {
      model: llmModel(),
      temperature: 0,
      max_tokens: 8192,
      stream: true,
      messages,
    };
    if (!omitTools) {
      body.tools = AGENT_TOOLS_OPENAI;
      body.tool_choice = toolChoice;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, status: res.status, detail: detail.slice(0, 500) };
    }
    if (!res.body) return { ok: false, status: 0, detail: "LLM stream had no body" };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let sawToolCall = false;
    const fragments: StreamToolFragment[] = [];

    const flushFrame = (frame: string): void => {
      if (frame.length === 0) return;
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) {
          data = line.slice(5).trimStart();
          break;
        }
      }
      if (data.length === 0 || data === "[DONE]") return;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return; // malformed frame — skip
      }
      const delta = json?.choices?.[0]?.delta;
      if (!delta || typeof delta !== "object") return;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        if (!sawToolCall) onContent(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const frag = fragments[idx] ?? { id: "", name: "", args: "" };
          if (typeof tc.id === "string" && tc.id.length > 0) frag.id = tc.id;
          if (tc.function && typeof tc.function.name === "string") frag.name += tc.function.name;
          if (tc.function && typeof tc.function.arguments === "string") frag.args += tc.function.arguments;
          fragments[idx] = frag;
          sawToolCall = true;
        }
      }
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        flushFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");
      }
    }
    if (buffer.length > 0) flushFrame(buffer);

    const toolCalls = fragments
      .filter((f) => f.name.length > 0)
      .map((f) => ({
        id: f.id || `call-${Math.random().toString(36).slice(2, 10)}`,
        type: "function",
        function: { name: f.name, arguments: f.args },
      }));

    return {
      ok: true,
      data: {
        choices: [
          {
            message: {
              content: toolCalls.length > 0 ? (content.length > 0 ? content : null) : content,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
      },
    };
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
  const softDeadlineMs = opts.softDeadlineMs
    ?? Number(process.env.AGENT_SOFT_DEADLINE_MS ?? AGENT_SOFT_DEADLINE_MS);
  // softDeadlineMs <= 0 DISABLES the soft deadline: the loop keeps
  // gathering evidence until it finishes naturally or hits the hard
  // timeout. The async dashboard path uses this (no time limit for
  // complex questions); the sync path keeps the edge-fitting default.
  const softEnabled = softDeadlineMs > 0;
  const softDeadline = Date.now() + Math.max(0, softDeadlineMs);
  let softForced = false;

  const envBase = (process.env.CMMS_API_URL ?? "").trim();
  const ctx: AgentToolContext = {
    baseUrl: opts.baseUrl ?? (envBase || AGENT_DEFAULT_BASE_URL),
    readToken: process.env.CMMS_API_TOKEN_READ ?? "",
    writeToken: process.env.CMMS_API_TOKEN_WRITE ?? "",
  };

  const messages: ChatMessage[] = buildMessages(input);
  const trace: AgentTraceStep[] = [];
  let resolvedCustomer: string | null = null;

  for (let i = 0; i < maxIterations; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AgentFailure(`agent loop timed out after ${opts.timeoutMs ?? AGENT_LOOP_TIMEOUT_MS}ms`);
    }

    // Soft deadline: past AGENT_SOFT_DEADLINE_MS the model must stop
    // gathering evidence and write the final answer from what it has.
    // Bounds the total latency inside the zrok edge's response window
    // so hard questions don't 504 for dashboard users. Disabled when
    // softDeadlineMs <= 0 (async jobs — no time limit).
    const pastSoft = softEnabled && Date.now() >= softDeadline;
    if (pastSoft && !softForced) {
      softForced = true;
      messages.push({
        role: "system",
        content:
          "TIME LIMIT REACHED: you must produce your final answer NOW, " +
          "based only on the evidence already in context. Do not call any " +
          "more tools, and do not say you lack information — summarize " +
          "what the tool results show.",
      });
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    let round: RoundResult;
    try {
      // Forced round: no tools in the payload at all — the model can
      // only write the final answer from the evidence in context.
      round = await chatOnce(messages, ac.signal, pastSoft ? "none" : "auto", pastSoft);
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
        answer_id: newUlid(),
        soft_deadline_forced: softForced,
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

// ---------------------------------------------------------------------------
// runAgentStream — the streaming loop
//
// Same loop as runAgent, but every LLM round uses stream:true and the
// progress is pushed through `emit` as typed events (the dashboard SPA
// renders them as a live activity trace + token-by-token answer text).
// The final `answer` event carries the full AgentOutcome; the route
// relays the stream verbatim and snapshots the feedback row afterwards.
//
// Token events flow ONLY during pure-content rounds (the final answer).
// Tool rounds emit tool_start / tool_done instead — their preamble
// text is buffered silently by chatOnceStream.
// ---------------------------------------------------------------------------

export type AgentStreamStatusPhase = "start" | "searching" | "synthesizing" | "soft_deadline";

export type AgentStreamEvent =
  | { type: "status"; phase: AgentStreamStatusPhase }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_done"; name: string; ok: boolean; note?: string; summary?: string }
  | { type: "token"; text: string }
  | { type: "answer"; outcome: AgentOutcome };

export type AgentStreamEmitter = (ev: AgentStreamEvent) => void;

/** Compact human-usable summary of a tool output for the live trace:
 *  prefers the JSON `summary` field, then `message`/`error`, then a
 *  trimmed head of the compacted text. */
function toolSummary(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.summary === "string" && parsed.summary.length > 0) return parsed.summary.slice(0, 300);
    if (typeof parsed?.message === "string" && parsed.message.length > 0) return parsed.message.slice(0, 300);
    if (typeof parsed?.error === "string" && parsed.error.length > 0) return parsed.error.slice(0, 300);
  } catch {
    // non-JSON — fall through to the head slice
  }
  const compact = compactToolText(raw);
  const oneLine = compact.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

export async function runAgentStream(
  input: AgentInput,
  opts: RunAgentOptions = {},
  emit: AgentStreamEmitter,
): Promise<AgentOutcome> {
  if (!llmConfigured()) {
    throw new AgentFailure("KILO_API_KEY is not configured");
  }
  const language: "hu" | "en" = input.language === "en" ? "en" : "hu";
  const maxIterations = opts.maxIterations ?? AGENT_MAX_ITERATIONS;
  const deadline = Date.now() + (opts.timeoutMs ?? AGENT_LOOP_TIMEOUT_MS);
  const softDeadlineMs = opts.softDeadlineMs
    ?? Number(process.env.AGENT_SOFT_DEADLINE_MS ?? AGENT_SOFT_DEADLINE_MS);
  const softEnabled = softDeadlineMs > 0;
  const softDeadline = Date.now() + Math.max(0, softDeadlineMs);
  let softForced = false;

  const envBase = (process.env.CMMS_API_URL ?? "").trim();
  const ctx: AgentToolContext = {
    baseUrl: opts.baseUrl ?? (envBase || AGENT_DEFAULT_BASE_URL),
    readToken: process.env.CMMS_API_TOKEN_READ ?? "",
    writeToken: process.env.CMMS_API_TOKEN_WRITE ?? "",
  };

  const messages: ChatMessage[] = buildMessages(input);
  const trace: AgentTraceStep[] = [];
  let resolvedCustomer: string | null = null;

  emit({ type: "status", phase: "start" });

  for (let i = 0; i < maxIterations; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AgentFailure(`agent loop timed out after ${opts.timeoutMs ?? AGENT_LOOP_TIMEOUT_MS}ms`);
    }

    const pastSoft = softEnabled && Date.now() >= softDeadline;
    if (pastSoft && !softForced) {
      softForced = true;
      messages.push({
        role: "system",
        content:
          "TIME LIMIT REACHED: you must produce your final answer NOW, " +
          "based only on the evidence already in context. Do not call any " +
          "more tools, and do not say you lack information — summarize " +
          "what the tool results show.",
      });
      emit({ type: "status", phase: "soft_deadline" });
    }
    emit({ type: "status", phase: pastSoft ? "synthesizing" : "searching" });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    let round: RoundResult;
    try {
      round = await chatOnceStream(
        messages,
        ac.signal,
        (text) => emit({ type: "token", text }),
        pastSoft ? "none" : "auto",
        pastSoft,
      );
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
      const outcome: AgentOutcome = {
        final_text: text,
        tool_trace: trace,
        iterations: i + 1,
        model: llmModel(),
        resolved_customer: resolvedCustomer,
        language,
        answer_id: newUlid(),
        soft_deadline_forced: softForced,
      };
      emit({ type: "answer", outcome });
      return outcome;
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

      emit({ type: "tool_start", name, args });
      const out = await callAgentTool(name, args, ctx);
      trace.push({ name, args, ok: out.ok, note: out.note });
      emit({
        type: "tool_done",
        name,
        ok: out.ok,
        ...(out.note ? { note: out.note } : {}),
        summary: toolSummary(out.text),
      });

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
