// Express app factory. Kept separate from index.ts so tests can build
// an app around a temp DB without starting the file watcher or listener.
import express from "express";
import type { OpenDbs } from "./db/open";
import type { JobCache } from "./cache/jobs";
import { healthRouter } from "./routes/health";
import { schemaRouter } from "./routes/schema";
import { indexRouter } from "./routes/index";
import { capabilitiesRouter } from "./routes/capabilities";
import { jobsRouter } from "./routes/jobs";
import { ticketsRouter } from "./routes/tickets";
import { integrationRouter } from "./routes/integration";
import { answerRouter } from "./routes/answer";
import { agentRouter } from "./routes/agent";
import { customersRouter } from "./routes/customers";
import { userFeedbackRouter, adminFeedbackRouter } from "./routes/feedback";
import { pushRouter } from "./routes/push";
import { requireAuth } from "./routes/auth";

export function createApp(dbs: OpenDbs, cache: JobCache): express.Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Per-request timeout: 15 seconds. Prevents a stuck handler (e.g. WAL
  // checkpoint, ETL rebuild) from consuming the worker thread indefinitely.
  // /v1/answer-agent runs a multi-round LLM + tool loop, so it gets a
  // 120s window (the dashboard proxy waits for it).
  app.use((req, res, next) => {
    // The agent routes (sync, stream, async) run multi-round LLM + tool
    // loops, so they get a 120s window (the dashboard proxy waits for
    // them). Everything else stays at 15s.
    const isAgent = req.path.startsWith("/v1/answer-agent");
    req.setTimeout(isAgent ? 120_000 : 15_000, () => {
      if (!res.headersSent) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "request_timeout", path: req.path, method: req.method }));
        res.status(504).json({ error: { code: "timeout", message: "Request timed out" } });
      }
    });
    next();
  });

  // Public: health.
  app.use(healthRouter(dbs, cache));

  // Read-protected: schema, capabilities, index, jobs reads, jobs search.
  const readGate = requireAuth({ write: false });
  app.use((req, res, next) => readGate(req, res, next));
  app.use(schemaRouter());
  app.use(capabilitiesRouter());
  app.use(indexRouter(cache));
  // jobsRouter carries its own write-gate on POST /v1/jobs and
  // POST /v1/jobs/:key/notes; reads pass through with the read token.
  app.use(jobsRouter(dbs, cache));
  // Phase 1: /v1/answer — server-side question router. Read-only,
  // goes through the same read-gate.
  app.use(answerRouter(cache, dbs));
  // Agentic Ask: /v1/answer-agent — openai/gpt-5.6-luna-pro picks and
  // calls the tools.
  // Read-gated like /v1/answer (the agent self-fetches with its own
  // read/write tokens internally).
  app.use(agentRouter(dbs));
  // ticketsRouter: interview-style ticket endpoints. Carries its own
  // write-gate on POST endpoints; GET endpoints (recent, etc.) pass
  // through with the read token.
  app.use(ticketsRouter(dbs, cache));
  // integrationRouter: read-only endpoints over the integrated CMMS CSV
  // data (serviz_belso, szev_igeny, telephely_munka, ais_motor, etc.).
  app.use(integrationRouter(dbs));
  // customersRouter: customer search + canonical-name grouping. Phase 2.
  app.use(customersRouter(dbs));
  // userFeedbackRouter: vote / my-votes / counters / correction. All
  // require a valid X-Cmms-Uid on the *user* side except the public
  // counters call. The user-feedback endpoints are read-gated because
  // they sit under the read token in the cmms-api side; the dashboard
  // proxy forwards the X-Cmms-Uid header from the browser.
  app.use(userFeedbackRouter(dbs));
  // adminFeedbackRouter: disliked list + settings. Write-gated.
  // NOTE: the write gate is path-scoped to the admin routes only. A
  // bare `app.use(writeGate)` here would apply the gate to EVERY
  // request that falls through the earlier routers — turning unknown
  // /v1/* paths from 404 into 403 (regression, fixed 2026-08-19).
  const writeGate = requireAuth({ write: true });
  app.use("/v1/feedback/disliked", writeGate);
  app.use("/v1/feedback/settings", writeGate);
  app.use(adminFeedbackRouter(dbs));
  // Web Push subscription management (Phase 8, 2026-08-24, F2).
  // Per-uid, no token gate (X-Cmms-Uid suffices).
  app.use(pushRouter(dbs));

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ t: new Date().toISOString(), msg: "unhandled_error", error: String(err?.message ?? err) }));
    res.status(500).json({ error: { code: "internal", message: String(err?.message ?? err) } });
  });

  return app;
}
