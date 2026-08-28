// Express app factory (post-pure-RAG rebuild).
//
// Routes:
//   GET  /v1/health          public readiness probe
//   POST /v1/chat/completions   bearer-gated, the single RAG endpoint
//
// The MCP server, the per-ticket write endpoints, the
// /v1/jobs/search primitive, the customer/integration routers —
// all gone. The "1 RAG tool" is /v1/chat/completions.
import express from "express";
import type { OpenDbs } from "./db/open";
import type { RagIndex } from "./lib/rag";
import { healthRouter } from "./routes/health";
import { answerRouter } from "./routes/answer";
import { requireAuth } from "./routes/auth";

export function createApp(dbs: OpenDbs, rag: RagIndex): express.Express {
  const app = express();
  app.use(express.json({ limit: "512kb" }));

  // Per-request timeout: 60s. The RAG endpoint is synchronous (FTS5
  // is fast, the LLM call is the slow part). 60s gives the Kilo
  // gateway a comfortable budget.
  app.use((req, res, next) => {
    req.setTimeout(60_000, () => {
      if (!res.headersSent) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "request_timeout", path: req.path, method: req.method }));
        res.status(504).json({ error: { code: "timeout", message: "Request timed out after 60s" } });
      }
    });
    next();
  });

  // Public health.
  app.use(healthRouter(dbs, rag));

  // Auth-gated chat endpoint. Mount the router at /v1/chat so the
  // inner "/completions" route becomes /v1/chat/completions.
  const readGate = requireAuth({ write: false });
  app.use("/v1/chat", readGate, answerRouter(dbs, rag));

  // 404 for everything else.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "This server exposes only /v1/health and /v1/chat/completions." } });
  });

  // Final error net. Never 500 on an unhandled throw — log + JSON
  // 500 so the client can show something.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ t: new Date().toISOString(), msg: "unhandled_error", error: String(err?.message ?? err), stack: err?.stack?.split("\n").slice(0, 3).join(" | ") }));
    if (!res.headersSent) {
      res.status(500).json({ error: { code: "internal", message: String(err?.message ?? err) } });
    }
  });

  return app;
}
