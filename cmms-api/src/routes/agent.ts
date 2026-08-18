// /v1/answer-agent — the agentic Ask endpoint.
//
// The LLM (gpt-4o via the Kilo Gateway) picks and calls the CMMS tools
// itself. Hybrid policy: answer_question (the deterministic router) is
// tool #0 with a strong prompt bias, and the rest of the tool surface
// is available for what the router can't cover.
//
// v2 (Option 2, 2026-08-18): the LLM composes the answer from raw
// evidence, calls 2-5 tools in parallel, and the curated tool surface
// (8 read + gated mutate) is the entire scope. Enabled when:
//   - the request body includes `agent: "v2"`, OR
//   - the request includes `?agent=v2` query, OR
//   - the server env `ASK_AGENT_V2=1` is set (server-wide default).
//
// Hard-fail contract (user decision 2026-08-13): there is NO
// deterministic fallback. Any LLM error / timeout / empty answer maps
// to 502 { error: { code: "agent_failed" } }; a missing Kilo key maps
// to 503 { error: { code: "agent_unconfigured" } }.
//
// Feedback snapshot (Phase 6, 2026-08-18): every successful run
// inserts a row into `feedback_answers` with the full agent payload.
// The dashboard's like/dislike buttons reference this row by
// `answer_id` (a fresh ULID generated here, returned as a new
// top-level field on the response). Failed runs (AgentFailure) do
// NOT snapshot — we only want the user to vote on real answers.
//
// The legacy POST /v1/answer stays untouched (MCP answer_question +
// old clients keep the deterministic contract).

import { Router as makeRouter, type Router } from "express";
import { randomBytes } from "node:crypto";
import { llmConfigured } from "../lib/llm";
import { AgentFailure, runAgent, runAgentV2 } from "../lib/agent";
import { routeQuestion, curateV2Toolset } from "../lib/router";
import type { OpenDbs } from "../db/open";
import { insertFeedbackAnswer } from "./feedback";

type AgentBody = {
  q?: string;
  language?: "hu" | "en";
  /** "v1" (default) or "v2" (option 2 — LLM composes answer). */
  agent?: "v1" | "v2";
};

function envV2Default(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.ASK_AGENT_V2 ?? "").trim());
}

// Crockford base32 ULID. 26 chars, monotonic-enough for our purposes
// (the time prefix is just the timestamp; randomness is 80 bits).
// We do NOT need true monotonic — the primary key is the answer_id,
// not a sort key.
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function makeUlid(): string {
  const now = Date.now();
  let t = now;
  const time = new Array(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = ULID_ALPHABET[t % 32];
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  const rest = new Array(16);
  for (let i = 0; i < 16; i++) rest[i] = ULID_ALPHABET[rand[i] % 32];
  return time.join("") + rest.join("");
}

export function agentRouter(dbs?: OpenDbs): Router {
  const r = makeRouter();

  r.post("/v1/answer-agent", async (req, res) => {
    const body = (req.body ?? {}) as AgentBody;
    const q = (body.q ?? "").trim();
    if (!q) {
      res.status(400).json({ error: { code: "missing_q", message: "q (the question) is required" } });
      return;
    }
    if (!llmConfigured()) {
      res.status(503).json({
        error: {
          code: "agent_unconfigured",
          message: "KILO_API_KEY is not configured; the agent cannot run.",
        },
      });
      return;
    }
    const language: "hu" | "en" = body.language === "en" ? "en" : "hu";
    // v2 dispatch: explicit body field wins, then ?agent=v2 query, then
    // the server-wide env default. Until the flip commit, the env is
    // off by default and v1 is the only path the prod user hits.
    const wantV2 =
      body.agent === "v2" ||
      (typeof req.query.agent === "string" && req.query.agent === "v2") ||
      (body.agent !== "v1" && envV2Default());
    try {
      const out = wantV2
        ? await runAgentV2(
            { question: q, language },
            {
              // State-aware v2: run the deterministic router first (0 LLM
              // tokens, ~5ms) to pick a 2-4 tool subset. The LLM then sees
              // only those tools + a tailored assignment, and can't
              // hallucinate filter fields the schema doesn't allow.
              curatedToolset: curateV2Toolset(routeQuestion(q, language), q, language),
            },
          )
        : await runAgent({ question: q, language });
      // Snapshot the answer for the like/dislike feature. The insert
      // is best-effort: a snapshot failure must NOT 502 the agent
      // (the user has a valid answer; we'd rather have no vote row
      // than no answer). We log to stderr for ops.
      let answerId: string | null = null;
      if (dbs) {
        try {
          answerId = makeUlid();
          insertFeedbackAnswer(dbs, {
            answer_id: answerId,
            q,
            final_text: out.final_text,
            tool_trace: out.tool_trace,
            model: out.model,
            iterations: out.iterations,
            language: out.language,
            resolved_customer: out.resolved_customer ?? null,
            ticket_cards: out.ticket_cards ?? null,
          });
        } catch (e) {
          answerId = null;
          // eslint-disable-next-line no-console
          console.error(JSON.stringify({
            t: new Date().toISOString(),
            msg: "feedback_snapshot_failed",
            error: String((e as Error)?.message ?? e),
          }));
        }
      }
      res.json(answerId ? { ...out, answer_id: answerId } : out);
    } catch (e) {
      if (e instanceof AgentFailure) {
        res.status(502).json({ error: { code: "agent_failed", message: e.message } });
        return;
      }
      throw e; // anything else is a real internal error → 500
    }
  });

  return r;
}
