// /v1/answer-agent — the agentic Ask endpoint.
//
// The LLM (gpt-4o via the Kilo Gateway) picks and calls the CMMS tools
// itself. Hybrid policy: answer_question (the deterministic router) is
// tool #0 with a strong prompt bias, and the rest of the tool surface
// is available for what the router can't cover.
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
import { AgentFailure, runAgent } from "../lib/agent";

type AgentBody = {
  q?: string;
  language?: "hu" | "en";
};

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
    try {
      const out = await runAgent({ question: q, language });
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
