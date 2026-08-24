// src/lib/push.ts
//
// Phase 8 (2026-08-24), brainstorm idea F2 — Web Push notifications
// via VAPID. The dashboard SPA registers a PushSubscription via
// `POST /v1/push/subscribe`; the server stores it in
// `push_subscriptions` keyed by uid. When an async agent job
// completes for that uid, the server fires a Web Push payload to
// every device the user has registered.
//
// VAPID keys live in env (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT). If VAPID_PRIVATE_KEY is missing the push service
// is a no-op — the SPA still subscribes, but the server can't
// actually fire anything. This lets dev work proceed without
// generating keys, and lets ops rotate keys via env reload.
//
// Why we don't auto-generate keys at startup:
//   - VAPID keys should be stable across server restarts (so existing
//     subscriptions don't break).
//   - Auto-generating would mean losing every device the moment the
//     server rebooted.
//   - Ops generates the keypair once with `web-push generate-vapid-keys`
//     and stores it in /etc/cmms-api.env.

import webpush from "web-push";
import type { OpenDbs } from "../db/open";
import { randomUUID } from "crypto";

export interface PushSubscriptionRow {
  id: number;
  uid: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

let configured = false;

function configure(): boolean {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@nctmechanic.local";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

/** Returns the VAPID public key. The SPA needs this to call
 *  `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: ... })`.
 *  Returns null when VAPID isn't configured on the server (the SPA
 *  hides the "subscribe" affordance). */
export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

/** True when the server can actually fire pushes. Use this as the
 *  gate on the SPA's subscribe button. */
export function pushEnabled(): boolean {
  return configure();
}

/** Register or refresh a subscription. The endpoint is the unique
 *  key — re-subscribing the same device just updates the existing
 *  row's keys + last_seen_at. Returns the row's id. */
export function upsertSubscription(
  dbs: OpenDbs,
  uid: string,
  input: PushSubscriptionInput,
  userAgent: string | null,
): number {
  if (!dbs.cms) throw new Error("push.upsertSubscription: main db is closed");
  const now = new Date().toISOString();
  const existing = dbs.cms
    .prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
    .get(input.endpoint) as { id: number } | undefined;
  if (existing) {
    dbs.cms
      .prepare(
        `UPDATE push_subscriptions
         SET uid = ?, p256dh = ?, auth = ?, user_agent = ?, last_seen_at = ?
         WHERE id = ?`,
      )
      .run(uid, input.keys.p256dh, input.keys.auth, userAgent, now, existing.id);
    return existing.id;
  }
  const info = dbs.cms
    .prepare(
      `INSERT INTO push_subscriptions (uid, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(uid, input.endpoint, input.keys.p256dh, input.keys.auth, userAgent, now, now);
  return Number(info.lastInsertRowid);
}

export function deleteSubscriptionByEndpoint(
  dbs: OpenDbs,
  uid: string,
  endpoint: string,
): boolean {
  if (!dbs.cms) throw new Error("push.deleteSubscriptionByEndpoint: main db is closed");
  const info = dbs.cms
    .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND uid = ?")
    .run(endpoint, uid);
  return info.changes > 0;
}

export function listSubscriptionsForUid(dbs: OpenDbs, uid: string): PushSubscriptionRow[] {
  if (!dbs.cms) throw new Error("push.listSubscriptionsForUid: main db is closed");
  return dbs.cms
    .prepare("SELECT * FROM push_subscriptions WHERE uid = ? ORDER BY created_at ASC")
    .all(uid) as PushSubscriptionRow[];
}

export function countSubscriptionsForUid(dbs: OpenDbs, uid: string): number {
  if (!dbs.cms) throw new Error("push.countSubscriptionsForUid: main db is closed");
  const row = dbs.cms
    .prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE uid = ?")
    .get(uid) as { n: number };
  return row.n;
}

export interface PushPayload {
  /** Short title — first line of the OS notification. */
  title: string;
  /** Body text — second line. Truncated by the OS. */
  body: string;
  /** Optional icon URL (16x16 to 256x256). Default uses /dashboard/icon-192.png. */
  icon?: string;
  /** Optional click-target URL. */
  url?: string;
  /** Tag — replaces any existing notification with the same tag. */
  tag?: string;
  /** Extra data passed to the service worker (visible to the JS
   *  notificationclick handler). */
  data?: Record<string, unknown>;
}

export interface PushSendResult {
  delivered: number;
  failed: number;
  pruned: number;
  errors: Array<{ endpoint: string; statusCode?: number; reason: string }>;
}

/**
 * Fire a Web Push payload to every device the user has subscribed.
 * Failures are normalized: HTTP 404/410 (subscription gone) deletes
 * the row so we don't keep trying; other errors are reported but
 * don't prune.
 */
export async function sendPushToUid(
  dbs: OpenDbs,
  uid: string,
  payload: PushPayload,
): Promise<PushSendResult> {
  const subs = listSubscriptionsForUid(dbs, uid);
  if (subs.length === 0 || !configure()) {
    return { delivered: 0, failed: 0, pruned: 0, errors: [] };
  }
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon ?? "/dashboard/icon-192.png",
    badge: "/dashboard/icon-192.png",
    url: payload.url ?? "/ask",
    tag: payload.tag,
    data: payload.data ?? {},
  });
  let delivered = 0;
  let failed = 0;
  let pruned = 0;
  const errors: PushSendResult["errors"] = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
          { TTL: 60 * 60, urgency: "normal" },
        );
        delivered += 1;
        // Refresh last_seen_at on success.
        if (dbs.cms) {
          dbs.cms
            .prepare("UPDATE push_subscriptions SET last_seen_at = ? WHERE id = ?")
            .run(new Date().toISOString(), sub.id);
        }
      } catch (e: unknown) {
        const err = e as { statusCode?: number; body?: string; message?: string };
        const statusCode = err.statusCode;
        const reason = err.body || err.message || String(e);
        // 404 (Not Found) and 410 (Gone) mean the subscription is dead
        // — the device unsubscribed, or the push service purged it.
        if (statusCode === 404 || statusCode === 410) {
          if (dbs.cms) {
            dbs.cms
              .prepare("DELETE FROM push_subscriptions WHERE id = ?")
              .run(sub.id);
          }
          pruned += 1;
        } else {
          failed += 1;
        }
        errors.push({ endpoint: sub.endpoint, statusCode, reason });
      }
    }),
  );
  return { delivered, failed, pruned, errors };
}

// ---------------------------------------------------------------------------
// Async-agent completion hook (Phase 8, 2026-08-24, F2 + A9 combo).
//
// The agent async route calls `notifyAsyncJobDone(dbs, job_id, final)`
// after the job completes (success or error). We look up the
// originating uid from a side-table populated when the job was
// created, and fire a Web Push if the user has any subscriptions.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

const ASYNC_JOB_OWNERS = new Map<string, { uid: string; q: string; startedAt: number }>();

export function registerAsyncJob(jobId: string, uid: string, q: string): void {
  ASYNC_JOB_OWNERS.set(jobId, { uid, q, startedAt: Date.now() });
}

export function unregisterAsyncJob(jobId: string): void {
  ASYNC_JOB_OWNERS.delete(jobId);
}

export function getAsyncJobOwner(
  jobId: string,
): { uid: string; q: string; startedAt: number } | null {
  return ASYNC_JOB_OWNERS.get(jobId) ?? null;
}

export async function notifyAsyncJobDone(
  dbs: OpenDbs,
  jobId: string,
  status: "done" | "error",
  finalText: string,
): Promise<PushSendResult> {
  const owner = ASYNC_JOB_OWNERS.get(jobId);
  if (!owner) return { delivered: 0, failed: 0, pruned: 0, errors: [] };
  const title =
    status === "done" ? "A válaszod megérkezett" : "A válasz készítése nem sikerült";
  const body =
    status === "done"
      ? `"${owner.q.slice(0, 60)}${owner.q.length > 60 ? "…" : ""}" — nyisd meg a CMMS-t a válaszhoz.`
      : `"${owner.q.slice(0, 60)}${owner.q.length > 60 ? "…" : ""}" — kattints az újrapróbálkozáshoz.`;
  const result = await sendPushToUid(dbs, owner.uid, {
    title,
    body,
    url: "/ask",
    tag: `agent-job-${jobId}`,
    data: { job_id: jobId, status, final_text: finalText.slice(0, 200) },
  });
  return result;
}

// Re-export for routes that want to mint a job id but don't need a
// crypto import.
export function mintJobId(): string {
  return randomUUID();
}

// Silence the "Database is declared but never used" ts error in
// places that import the type only via the OpenDbs shape.
export type _Db = Database.Database;
