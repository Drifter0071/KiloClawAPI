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
// The legacy POST /v1/answer stays untouched (MCP answer_question +
// old clients keep the deterministic contract).

import { Router as makeRouter, type Router } from "express";
import { llmConfigured } from "../lib/llm";
import { AgentFailure, runAgent, runAgentV2 } from "../lib/agent";
import { routeQuestion, curateV2Toolset } from "../lib/router";

type AgentBody = {
  q?: string;
  language?: "hu" | "en";
  /** "v1" (default) or "v2" (option 2 — LLM composes answer). */
  agent?: "v1" | "v2";
};

function envV2Default(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.ASK_AGENT_V2 ?? "").trim());
}

export function agentRouter(): Router {
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
      res.json(out);
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
