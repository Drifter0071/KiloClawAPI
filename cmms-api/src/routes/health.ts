// /v1/health — readiness probe.
//
// Public (no auth). Reports FTS5 row count, last ETL mtime, and the
// resolved DB paths so a watcher / Lobe Chat operator can confirm
// the RAG index is loaded.
import type { Router } from "express";
import { Router as makeRouter } from "express";
import type { OpenDbs } from "../db/open";
import type { RagIndex } from "../lib/rag";

export function healthRouter(dbs: OpenDbs, rag: RagIndex): Router {
  const r = makeRouter();
  r.get("/v1/health", (_req, res) => {
    const lastMtime = (dbs.stmts.getMeta.get("last_mtime") as { value: string } | undefined)?.value ?? null;
    res.json({
      ok: true,
      etl_mtime: lastMtime ? Number(lastMtime) : null,
      rag_rows: rag.size(),
      cmms_path: dbs.cmmsPath,
      rag_path: dbs.specializedPath,
      mode: "pure-rag",
    });
  });
  return r;
}
