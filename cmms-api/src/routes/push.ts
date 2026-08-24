// src/routes/push.ts
//
// Phase 8 (2026-08-24), brainstorm idea F2 — Web Push subscription
// management. The SPA calls:
//   GET    /v1/push/public-key → the VAPID public key
//   GET    /v1/push/status     → { enabled, count } for the uid
//   POST   /v1/push/subscribe  → register a subscription
//   DELETE /v1/push/subscribe  → unregister by endpoint
//   POST   /v1/push/test       → fire a test push (for verification)
//
// Authentication: the same X-Cmms-Uid header the rest of the
// dashboard routes use. We don't gate on the read/write tokens
// because subscriptions are per-user, not per-question.

import type { Router } from "express";
import { Router as makeRouter } from "express";
import { z } from "zod";
import type { OpenDbs } from "../db/open";
import {
  countSubscriptionsForUid,
  deleteSubscriptionByEndpoint,
  getVapidPublicKey,
  listSubscriptionsForUid,
  pushEnabled,
  sendPushToUid,
  upsertSubscription,
} from "../lib/push";

const SubscribeBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const DeleteBody = z.object({
  endpoint: z.string().url(),
});

export function pushRouter(dbs: OpenDbs): Router {
  const r = makeRouter();

  // Read the bearer for the X-Cmms-Uid header.
  function readUid(req: import("express").Request): string | null {
    const raw = req.header("x-cmms-uid");
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    return raw.trim();
  }

  r.get("/v1/push/public-key", (_req, res) => {
    const key = getVapidPublicKey();
    res.json({
      enabled: pushEnabled(),
      publicKey: key,
    });
  });

  r.get("/v1/push/status", (req, res) => {
    const uid = readUid(req);
    if (!uid) {
      res.status(400).json({ error: { code: "missing_uid", message: "X-Cmms-Uid header required" } });
      return;
    }
    const count = countSubscriptionsForUid(dbs, uid);
    res.json({ enabled: pushEnabled(), count, devices: listSubscriptionsForUid(dbs, uid) });
  });

  r.post("/v1/push/subscribe", (req, res) => {
    const uid = readUid(req);
    if (!uid) {
      res.status(400).json({ error: { code: "missing_uid", message: "X-Cmms-Uid header required" } });
      return;
    }
    if (!pushEnabled()) {
      res.status(503).json({
        error: {
          code: "push_disabled",
          message: "A push szolgáltatás nincs konfigurálva a szerveren (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY hiányzik).",
        },
      });
      return;
    }
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "bad_request", message: parsed.error.message },
      });
      return;
    }
    const userAgent = req.header("user-agent") ?? null;
    const id = upsertSubscription(dbs, uid, parsed.data, userAgent);
    res.json({ id, endpoint: parsed.data.endpoint });
  });

  r.delete("/v1/push/subscribe", (req, res) => {
    const uid = readUid(req);
    if (!uid) {
      res.status(400).json({ error: { code: "missing_uid", message: "X-Cmms-Uid header required" } });
      return;
    }
    const parsed = DeleteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_request", message: parsed.error.message } });
      return;
    }
    const ok = deleteSubscriptionByEndpoint(dbs, uid, parsed.data.endpoint);
    res.json({ deleted: ok });
  });

  // Test fire — used by the SPA's "test push" button to verify the
  // round-trip end-to-end. Returns the per-subscription delivery
  // report.
  r.post("/v1/push/test", async (req, res) => {
    const uid = readUid(req);
    if (!uid) {
      res.status(400).json({ error: { code: "missing_uid", message: "X-Cmms-Uid header required" } });
      return;
    }
    const result = await sendPushToUid(dbs, uid, {
      title: "Teszt push — NCT CMMS",
      body: "Ha ezt látod, a push értesítés működik. 👍",
      url: "/ask",
      tag: "test-push",
    });
    res.json(result);
  });

  return r;
}
