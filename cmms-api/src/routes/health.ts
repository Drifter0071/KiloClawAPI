import type { Router } from "express";
import { Router as makeRouter } from "express";
import type { OpenDbs } from "../db/open";
import type { JobCache } from "../cache/jobs";

function handleHealth(dbs: OpenDbs, cache: JobCache, _req: any, res: any) {
  const lastMtime = (dbs.stmts.getMeta.get("last_mtime") as { value: string } | undefined)?.value ?? null;
  res.json({
    ok: true,
    etl_mtime: lastMtime ? Number(lastMtime) : null,
    jobs: cache.size(),
    cmms_path: dbs.cmmsPath,
  });
}

export function healthRouter(dbs: OpenDbs, cache: JobCache): Router {
  const r = makeRouter();
  // Public, no auth — both paths. `/v1/health` is the canonical one;
  // `/health` is a convenience alias for ops dashboards / tunnel
  // health probes that hit the root path.
  r.get("/v1/health", (req, res) => handleHealth(dbs, cache, req, res));
  r.get("/health", (req, res) => handleHealth(dbs, cache, req, res));
  return r;
}
