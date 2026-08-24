import type { Router } from "express";
import { Router as makeRouter } from "express";
import type { JobCache } from "../cache/jobs";

export function indexRouter(cache: JobCache): Router {
  const r = makeRouter();
  r.get("/v1/index", (_req, res) => {
    res.json(cache.index());
  });
  // Machine-scoped ask: substring device search for the Ask page's
  // machine picker. `q` (min 2 chars), `limit` 1..50 (default 20).
  // Each entry is `{ name, tickets, customer_name }` where `tickets`
  // is the combined count from main CMMS + serviz_belso + szev_igeny
  // + telephely_munka (matches what find_related_tickets would
  // surface), and `customer_name` is the most-frequent customer that
  // owns the device (best-effort disambiguation when several similar
  // serial numbers exist).
  r.get("/v1/devices", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const requested = Number(req.query.limit ?? "20");
    const limit = Number.isFinite(requested)
      ? Math.min(50, Math.max(1, Math.floor(requested)))
      : 20;
    res.json({ devices: cache.listDevices(q, limit), q, limit });
  });
  return r;
}
