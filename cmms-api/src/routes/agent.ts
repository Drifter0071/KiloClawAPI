// /v1/answer-agent — the agentic Ask endpoint.
//
// The LLM (openai/gpt-5.6-luna-pro via the Kilo Gateway) picks and
// calls the CMMS tools itself. Hybrid policy: answer_question (the
// deterministic router) is
// tool #0 with a strong prompt bias, and the rest of the tool surface
// is available for what the router can't cover.
//
// Hard-fail contract (user decision 2026-08-13): there is NO
// deterministic fallback. Any LLM error / timeout / empty answer maps
// to 502 { error: { code: "agent_failed" } }; a missing Kilo key maps
// to 503 { error: { code: "agent_unconfigured" } }.
//
// Async path (2026-08-19): the dashboard sits behind the zrok edge,
// which cuts proxied responses at ~60s. Complex questions (machine
// history across years, cross-database lookups) need 1-3 minutes, so
// the dashboard path runs the agent as a background JOB:
//   POST /v1/answer-agent/async  → 202 { job_id, status: "running" }
//   GET  /v1/answer-agent/async/:jobId → running | done | error
// The async job DISABLES the soft deadline (softDeadlineMs: 0) and
// raises the hard timeout to 5 minutes — the model gathers ALL the
// evidence it needs, no time limit. The sync POST below keeps the
// soft-deadline default for direct API clients that still need the
// response to fit their own timeout.
//
// The legacy POST /v1/answer stays untouched (MCP answer_question +
// old clients keep the deterministic contract).

import { Router as makeRouter, type Router } from "express";
import { randomUUID } from "node:crypto";
import { llmConfigured } from "../lib/llm";
import {
  AgentFailure,
  runAgent,
  runAgentStream,
  type AgentHistoryTurn,
  type AgentOutcome,
} from "../lib/agent";
import type { OpenDbs } from "../db/open";
import { insertFeedbackAnswer } from "./feedback";

type AgentBody = {
  q?: string;
  language?: "hu" | "en";
  /** Optional per-run overrides (used by the async path). */
  timeoutMs?: number;
  softDeadlineMs?: number;
  /** Same-thread context carry: prior turns from the SPA's active
   *  chat thread (max 12, each ≤ 2000 chars). */
  history?: AgentHistoryTurn[];
  /** Machine-scoped ask: default scope picked before the question
   *  (device / customer / sorszam, each ≤ 200 chars). */
  context?: { device?: string; customer?: string; sorszam?: string };
};

type RunParams = {
  q: string;
  language: "hu" | "en";
  timeoutMs: number | undefined;
  softDeadlineMs: number | undefined;
  history?: AgentHistoryTurn[];
  context?: { device?: string; customer?: string; sorszam?: string };
};

const HISTORY_MAX_TURNS = 12;
const HISTORY_MAX_TEXT = 2000;
const CONTEXT_MAX_LEN = 200;

/** Clamps history/context to the documented bounds. Non-array / malformed
 *  entries are dropped silently (defensive — the SPA sends well-formed
 *  values; we never want a client bug to 500 the agent). */
function sanitizeHistory(raw: unknown): AgentHistoryTurn[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: AgentHistoryTurn[] = [];
  for (const h of raw.slice(-HISTORY_MAX_TURNS)) {
    if (typeof h !== "object" || h === null) continue;
    const b = h as { role?: unknown; text?: unknown };
    const role = b.role === "assistant" ? "assistant" : "user";
    const text = typeof b.text === "string" ? b.text.trim().slice(0, HISTORY_MAX_TEXT) : "";
    if (text.length === 0) continue;
    out.push({ role, text });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeContext(raw: unknown): { device?: string; customer?: string; sorszam?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const b = raw as { device?: unknown; customer?: unknown; sorszam?: unknown };
  const out: { device?: string; customer?: string; sorszam?: string } = {};
  for (const k of ["device", "customer", "sorszam"] as const) {
    if (typeof b[k] === "string") {
      const v = (b[k] as string).trim().slice(0, CONTEXT_MAX_LEN);
      if (v.length > 0) out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parses + validates the request body. Returns a 4xx/5xx error object
 *  shaped like `{ status, code, message }` when the request is invalid. */
function parseRunParams(body: unknown): RunParams | { error: { status: number; code: string; message: string } } {
  const b = (body ?? {}) as AgentBody;
  const q = (b.q ?? "").trim();
  if (!q) return { error: { status: 400, code: "missing_q", message: "q (the question) is required" } };
  if (!llmConfigured()) {
    return {
      error: {
        status: 503,
        code: "agent_unconfigured",
        message: "KILO_API_KEY is not configured; the agent cannot run.",
      },
    };
  }
  const language: "hu" | "en" = b.language === "en" ? "en" : "hu";
  // Clamp the overrides to sane bounds (undefined = caller default).
  const timeoutMs = clampInt(b.timeoutMs, 10_000, 600_000);
  const softDeadlineMs = clampInt(b.softDeadlineMs, 0, 600_000);
  const history = sanitizeHistory(b.history);
  const context = sanitizeContext(b.context);
  return { q, language, timeoutMs, softDeadlineMs, ...(history ? { history } : {}), ...(context ? { context } : {}) };
}

function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Runs the agent and best-effort snapshots the answer for the
 *  like/dislike feature. The snapshot failure must NOT fail the run —
 *  the user has a valid answer; they just can't vote on it. */
async function runAndSnapshot(dbs: OpenDbs, params: RunParams, opts: { timeoutMs?: number; softDeadlineMs?: number }): Promise<AgentOutcome> {
  const out = await runAgent(
    {
      question: params.q,
      language: params.language,
      ...(params.history ? { history: params.history } : {}),
      ...(params.context ? { context: params.context } : {}),
    },
    {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.softDeadlineMs !== undefined ? { softDeadlineMs: opts.softDeadlineMs } : {}),
    },
  );
  try {
    insertFeedbackAnswer(dbs, {
      answer_id: out.answer_id,
      q: params.q,
      final_text: out.final_text,
      tool_trace: out.tool_trace,
      model: out.model,
      iterations: out.iterations,
      language: out.language,
      resolved_customer: out.resolved_customer,
      ticket_cards: null,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      t: new Date().toISOString(),
      msg: "feedback_snapshot_failed",
      error: String((e as Error)?.message ?? e),
    }));
  }
  return out;
}

function logSoftDeadlineForced(out: AgentOutcome, q: string): void {
  if (out.soft_deadline_forced) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      msg: "agent_soft_deadline_forced",
      q,
      iterations: out.iterations,
      final_len: out.final_text.length,
    }));
  }
}

// ---------------------------------------------------------------------------
// Async job store (in-process). Jobs live as long as the process does; a
// binary restart (deploy) drops them, which the SPA surfaces as a friendly
// "server restarted" error. TTL sweep keeps the map bounded.
// ---------------------------------------------------------------------------

type AgentJob =
  | { status: "running"; startedAt: number }
  | { status: "done"; startedAt: number; result: AgentOutcome }
  | { status: "error"; startedAt: number; error: { code: string; message: string } };

const jobs = new Map<string, AgentJob>();
const ASYNC_JOB_TTL_MS = 15 * 60 * 1000; // 15 minutes
const ASYNC_DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes — complex questions need it

function pruneJobs(): void {
  const cutoff = Date.now() - ASYNC_JOB_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.startedAt < cutoff) jobs.delete(id);
  }
  // Absolute cap: keep the 200 newest entries, drop the rest.
  if (jobs.size > 200) {
    const ids = [...jobs.entries()]
      .sort((a, b) => b[1].startedAt - a[1].startedAt)
      .slice(200)
      .map(([id]) => id);
    for (const id of ids) jobs.delete(id);
  }
}

export function agentRouter(db: OpenDbs): Router {
  const r = makeRouter();

  // -------------------------------------------------------------------------
  // Sync path (legacy + direct API clients): soft deadline default ON.
  // -------------------------------------------------------------------------
  r.post("/v1/answer-agent", async (req, res) => {
    const parsed = parseRunParams(req.body);
    if ("error" in parsed) {
      res.status(parsed.error.status).json({ error: parsed.error });
      return;
    }
    try {
      const out = await runAndSnapshot(db, parsed, {
        timeoutMs: parsed.timeoutMs,
        softDeadlineMs: parsed.softDeadlineMs,
      });
      res.json(out);
      logSoftDeadlineForced(out, parsed.q);
    } catch (e) {
      if (e instanceof AgentFailure) {
        res.status(502).json({ error: { code: "agent_failed", message: e.message } });
        return;
      }
      throw e; // anything else is a real internal error → 500
    }
  });

  // -------------------------------------------------------------------------
  // Streaming path (2026-08-19): POST /v1/answer-agent/stream — SSE.
  // A single long-lived response that relays runAgentStream's progress
  // events (status / tool_start / tool_done / token / answer) as SSE
  // frames. Keeps the 35s soft-deadline default so the whole stream
  // fits the zrok edge's ~60s response window. On AgentFailure we emit
  // an `error` event and end the stream (hard-fail contract — no
  // deterministic fallback, same as the sync route).
  // -------------------------------------------------------------------------
  r.post("/v1/answer-agent/stream", async (req, res) => {
    const parsed = parseRunParams(req.body);
    if ("error" in parsed) {
      res.status(parsed.error.status).json({ error: parsed.error });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable nginx-style response buffering (Bun's server doesn't
      // buffer anyway, but proxies in front of it may).
      "x-accel-buffering": "no",
    });

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let settled = false;
    const flush = (): void => {
      try {
        // Express's default flush policy buffers; force the frame out.
        (res as unknown as { flush?: () => void }).flush?.();
      } catch {
        // ignore — some environments have no flush()
      }
    };

    try {
      const out = await runAgentStream(
        {
          question: parsed.q,
          language: parsed.language,
          ...(parsed.history ? { history: parsed.history } : {}),
          ...(parsed.context ? { context: parsed.context } : {}),
        },
        {
          ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
          ...(parsed.softDeadlineMs !== undefined ? { softDeadlineMs: parsed.softDeadlineMs } : {}),
        },
        (ev) => {
          if (settled) return;
          switch (ev.type) {
            case "status":
              send("status", { phase: ev.phase });
              break;
            case "tool_start":
              send("tool_start", { name: ev.name, args: ev.args });
              break;
            case "tool_done":
              send("tool_done", {
                name: ev.name,
                ok: ev.ok,
                ...(ev.note ? { note: ev.note } : {}),
                ...(ev.summary ? { summary: ev.summary } : {}),
              });
              break;
            case "token":
              send("token", { text: ev.text });
              break;
            case "answer":
              settled = true;
              send("answer", ev.outcome);
              break;
          }
          flush();
        },
      );
      try {
        insertFeedbackAnswer(db, {
          answer_id: out.answer_id,
          q: parsed.q,
          final_text: out.final_text,
          tool_trace: out.tool_trace,
          model: out.model,
          iterations: out.iterations,
          language: out.language,
          resolved_customer: out.resolved_customer,
          ticket_cards: null,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({
          t: new Date().toISOString(),
          msg: "feedback_snapshot_failed",
          error: String((e as Error)?.message ?? e),
        }));
      }
      logSoftDeadlineForced(out, parsed.q);
    } catch (e) {
      if (!settled) {
        settled = true;
        if (e instanceof AgentFailure) {
          send("error", { code: "agent_failed", message: e.message });
        } else {
          send("error", { code: "internal", message: String((e as Error)?.message ?? e) });
          // eslint-disable-next-line no-console
          console.error(JSON.stringify({
            t: new Date().toISOString(),
            msg: "agent_stream_internal_error",
            error: String((e as Error)?.message ?? e),
          }));
        }
        flush();
      }
    } finally {
      res.end();
    }
  });

  // -------------------------------------------------------------------------
  // Async path: NO soft deadline, 5-minute hard timeout — the dashboard
  // can wait as long as the question needs.
  // -------------------------------------------------------------------------
  r.post("/v1/answer-agent/async", async (req, res) => {
    const parsed = parseRunParams(req.body);
    if ("error" in parsed) {
      res.status(parsed.error.status).json({ error: parsed.error });
      return;
    }
    pruneJobs();
    const jobId = randomUUID();
    const startedAt = Date.now();
    jobs.set(jobId, { status: "running", startedAt });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      msg: "agent_async_start",
      job_id: jobId,
      q: parsed.q.slice(0, 200),
    }));
    runAndSnapshot(db, parsed, { timeoutMs: ASYNC_DEFAULT_TIMEOUT_MS, softDeadlineMs: 0 })
      .then((result) => {
        jobs.set(jobId, { status: "done", startedAt, result });
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          t: new Date().toISOString(),
          msg: "agent_async_done",
          job_id: jobId,
          q: parsed.q.slice(0, 200),
          elapsed_s: Math.round((Date.now() - startedAt) / 1000),
          iterations: result.iterations,
          final_len: result.final_text.length,
        }));
      })
      .catch((e: unknown) => {
        const err = e instanceof AgentFailure
          ? { code: "agent_failed", message: e.message }
          : { code: "internal", message: String((e as Error)?.message ?? e) };
        jobs.set(jobId, { status: "error", startedAt, error: err });
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({
          t: new Date().toISOString(),
          msg: "agent_async_failed",
          job_id: jobId,
          q: parsed.q.slice(0, 200),
          error: err,
        }));
      });
    res.status(202).json({ job_id: jobId, status: "running" });
  });

  r.get("/v1/answer-agent/async/:jobId", (req, res) => {
    const job = jobs.get(String(req.params.jobId ?? ""));
    if (!job) {
      res.status(404).json({ error: { code: "job_not_found", message: "Unknown job (the server may have restarted)." } });
      return;
    }
    if (job.status === "running") {
      res.json({ job_id: req.params.jobId, status: "running", elapsed_s: Math.round((Date.now() - job.startedAt) / 1000) });
      return;
    }
    if (job.status === "done") {
      res.json({ job_id: req.params.jobId, status: "done", result: job.result });
      return;
    }
    res.json({ job_id: req.params.jobId, status: "error", error: job.error });
  });

  return r;
}
