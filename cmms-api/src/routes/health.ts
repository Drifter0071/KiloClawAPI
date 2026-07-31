import type { Router } from "express";
import { Router as makeRouter } from "express";
import type { OpenDbs } from "../db/open";
import type { JobCache } from "../cache/jobs";

export function healthRouter(dbs: OpenDbs, cache: JobCache): Router {
  const r = makeRouter();
  r.get("/v1/health", (_req, res) => {
    const lastMtime = (dbs.stmts.getMeta.get("last_mtime") as { value: string } | undefined)?.value ?? null;
    res.json({
      ok: true,
      etl_mtime: lastMtime ? Number(lastMtime) : null,
      jobs: cache.size(),
      cmms_path: dbs.cmmsPath,
    });
  });
  return r;
}
