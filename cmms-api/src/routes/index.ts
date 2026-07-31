import type { Router } from "express";
import { Router as makeRouter } from "express";
import type { JobCache } from "../cache/jobs";

export function indexRouter(cache: JobCache): Router {
  const r = makeRouter();
  r.get("/v1/index", (_req, res) => {
    res.json(cache.index());
  });
  return r;
}
