// Dashboard HTTP server module.
//
// Served on the same port as the MCP HTTP transport (8788). All /dashboard*
// routes are gated by a password login. Once logged in, the browser
// session is a signed cookie; the dashboard uses that cookie to proxy
// requests to the cmms-api REST endpoints with the configured bearer
// token (CMMS_API_TOKEN_READ or CMMS_API_TOKEN_WRITE).
//
// Env vars (all optional — without DASHBOARD_PASSWORD the dashboard is
// fully off and /dashboard returns 404):
//   DASHBOARD_USER_PASSWORD   - the password the operator enters on the
//                               /dashboard/v2/login page (regular app)
//   DASHBOARD_ADMIN_PASSWORD  - the password the admin enters on the
//                               /dashboard/admin/login page
//                               (standalone admin SPA)
//   DASHBOARD_PASSWORD        - legacy single-password fallback. If
//                               set but the *USER / *ADMIN vars are
//                               not, both surfaces use this value. Use
//                               the explicit *_PASSWORD vars when you
//                               want to keep the operator and admin
//                               secrets different.
//   DASHBOARD_COOKIE_SECRET   - secret used to sign the session cookie
//                               (default: a random value at process start
//                               — fine for a single-instance dashboard,
//                               set explicitly if you want stable sessions
//                               across restarts)
//
// Endpoints:
//   GET  /dashboard/v2/        - v2 SPA shell (redirects to /ask if authed)
//   GET  /dashboard/v2/login   - v2 SPA shell (renders LoginPage if not authed)
//   POST /dashboard/login      - check password, set cookie, return JSON token
//   POST /dashboard/logout     - clear cookie
//   GET  /dashboard/api/*      - JSON API (cookie OR bearer token auth)
//
// All API routes return JSON. Errors are returned as {error: "..."}.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";

// Cookie + auth helpers --------------------------------------------------

const COOKIE_NAME = "cmms_dash_sid";
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours
const COOKIE_SECRET = process.env.DASHBOARD_COOKIE_SECRET
  || randomBytes(32).toString("hex");

// Admin cookie: separate from the operator cookie so the maintenance
// lock can wipe user sessions without locking out the admin, and a
// stolen operator cookie does NOT unlock admin endpoints. Short TTL
// (3 min) is enforced both server-side and client-side (the SPA's
// AdminPanelPage shows a countdown and force-logs-out at 0).
const ADMIN_COOKIE_NAME = "cmms_dash_admin_sid";
const ADMIN_COOKIE_MAX_AGE = 3 * 60; // 3 minutes

// Resolved dashboard passwords. The user + admin split was added in
// Phase 9 so the operator UI and the operations panel can be opened
// by different people with different secrets. We fall back to the
// legacy DASHBOARD_PASSWORD for backwards compatibility — if only
// the legacy env is set, both surfaces use it (matching the previous
// single-password behaviour). The user / admin split means setting
// just DASHBOARD_PASSWORD no longer lets the admin UI see operator
// endpoints (and vice versa); the cookies are also separate, so even
// if the legacy single password is used, the two surfaces stay
// isolated by cookie name.
//
// IMPORTANT: these are getter functions, not consts, because the
// dashboard auth test file mutates process.env at test-time after
// the module is already loaded. A const snapshot at import time
// would miss those mutations and break the existing test contract.
function getDashboardUserPassword(): string {
  const p = process.env.DASHBOARD_USER_PASSWORD;
  if (p && p.length > 0) return p;
  return process.env.DASHBOARD_PASSWORD ?? "";
}
function getDashboardAdminPassword(): string {
  const p = process.env.DASHBOARD_ADMIN_PASSWORD;
  if (p && p.length > 0) return p;
  return process.env.DASHBOARD_PASSWORD ?? "";
}

function sign(value: string): string {
  return createHmac("sha256", COOKIE_SECRET).update(value).digest("hex");
}
function makeCookie(sessionId: string): string {
  const sig = sign(sessionId);
  return [
    `${COOKIE_NAME}=${sessionId}.${sig}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ].join("; ");
}
function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
function makeAdminCookie(sessionId: string): string {
  const sig = sign(sessionId);
  return [
    `${ADMIN_COOKIE_NAME}=${sessionId}.${sig}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ADMIN_COOKIE_MAX_AGE}`,
  ].join("; ");
}
function clearAdminCookie(): string {
  return `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
function checkCookie(req: Request): boolean {
  if (!getDashboardUserPassword()) return false;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!m) return false;
  const [sid, sig] = m[1].split(".");
  if (!sid || !sig) return false;
  const expected = sign(sid);
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
/** Admin cookie check. Independent of the operator cookie — a valid
 *  operator cookie does NOT unlock admin endpoints. */
function checkAdminCookie(req: Request): boolean {
  if (!getDashboardAdminPassword()) return false;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE_NAME}=([^;]+)`));
  if (!m) return false;
  const [sid, sig] = m[1].split(".");
  if (!sid || !sig) return false;
  const expected = sign(sid);
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// Bearer-token check. Used as a fallback for the dashboard API when
// the cookie is gone (tab reopened, cookie cleared, etc.). The bearer
// token is the same as CMMS_API_TOKEN_READ, which the dashboard JS
// receives on login and stores in sessionStorage.
function checkBearer(req: Request): boolean {
  const expected = getReadToken();
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // Constant-time compare against the read token
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Combined check: either cookie OR bearer is fine.
function isAuthenticated(req: Request): boolean {
  return checkCookie(req) || checkBearer(req);
}

// Constant-time password compare
function passwordOk(submitted: string, expected: string): boolean {
  if (typeof submitted !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// HTML loader ------------------------------------------------------------

const DASHBOARD_DIR = import.meta.dir;
function loadHtml(name: string): string {
  const p = join(DASHBOARD_DIR, name);
  if (!existsSync(p)) return `<h1>dashboard: ${name} missing on server</h1>`;
  return readFileSync(p, "utf-8");
}

const ASSET_MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
function assetContentType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return ASSET_MIME[ext] ?? "application/octet-stream";
}

// Lazy env accessors. Reading process.env at module load time would
// capture the value at import, which breaks tests that set the env
// after import (Bun hoists imports above statements). At request
// time, we want the *current* value of process.env.
function getReadToken(): string {
  return process.env.CMMS_API_TOKEN_READ ?? "";
}
function getWriteToken(): string {
  return process.env.CMMS_API_TOKEN_WRITE ?? "";
}
function getBaseUrl(): string {
  return process.env.CMMS_API_URL ?? "http://127.0.0.1:8787";
}

// In-memory state --------------------------------------------------------
//
// stream subscribers + approval queue + recent audit log. These are
// in-memory; the audit log persists to /opt/cmms-api/audit.log on disk
// if AUDIT_LOG_PATH is set.

export interface StreamEvent {
  type: "question" | "approval" | "answer";
  t: string;
  [k: string]: unknown;
}
const streamSubscribers = new Set<(ev: StreamEvent) => void>();
const auditLog: Array<{ t: string; action: string; tool?: string; user?: string; detail?: string }> = [];
const auditLogPath = process.env.AUDIT_LOG_PATH; // optional
const approvals = new Map<string, { id: string; t: string; action: string; summary: string; resolved: boolean }>();
let nextApprovalId = 1;

// Admin state (in-memory) ------------------------------------------------
//
// maintenance: when true, every operator session is killed on the next
// request and the LoginPage shows the "Karbantartás alatt" banner.
//
// activeSessions: the count of operator sessions seen in the last
// ACTIVE_SESSION_WINDOW_MS milliseconds. We track this by hooking the
// existing checkCookie path: any cookie-authenticated request bumps
// the session's last-seen timestamp.
const MAINTENANCE = { enabled: false, since: null as string | null };
const ACTIVE_SESSION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const activeSessionSeen = new Map<string, number>(); // sid -> lastSeenMs
let totalSessionsEver = 0;

function recordSessionSeen(sid: string): void {
  const now = Date.now();
  // Prune stale entries so the map doesn't grow forever.
  if (activeSessionSeen.size > 1000) {
    const cutoff = now - ACTIVE_SESSION_WINDOW_MS;
    for (const [k, v] of activeSessionSeen) {
      if (v < cutoff) activeSessionSeen.delete(k);
    }
  }
  if (!activeSessionSeen.has(sid)) totalSessionsEver += 1;
  activeSessionSeen.set(sid, now);
}

function countActiveSessions(): number {
  const cutoff = Date.now() - ACTIVE_SESSION_WINDOW_MS;
  let n = 0;
  for (const [k, v] of activeSessionSeen) {
    if (v >= cutoff) n += 1;
    else activeSessionSeen.delete(k);
  }
  return n;
}

function pushAudit(entry: { action: string; tool?: string; user?: string; detail?: string }) {
  const e = { t: new Date().toISOString(), ...entry };
  auditLog.push(e);
  if (auditLog.length > 500) auditLog.splice(0, auditLog.length - 500);
  if (auditLogPath) {
    try { appendFileSync(auditLogPath, JSON.stringify(e) + "\n"); } catch { /* ignore */ }
  }
}

// Public API for the rest of mcp-server.ts to push events
export function emitStreamEvent(ev: StreamEvent) {
  for (const s of streamSubscribers) {
    try { s(ev); } catch { /* ignore */ }
  }
  if (ev.type === "question") {
    pushAudit({ action: "question", tool: String(ev.tool || ""), detail: String(ev.q || "").slice(0, 200) });
  } else if (ev.type === "answer") {
    pushAudit({ action: "answer", tool: String(ev.tool || ""), detail: String(ev.summary || "").slice(0, 200) });
  } else if (ev.type === "approval") {
    pushAudit({ action: "approval", tool: String(ev.action || ""), detail: String(ev.summary || "").slice(0, 200) });
  }
}

export function pushApproval(action: string, summary: string): string {
  const id = String(nextApprovalId++);
  approvals.set(id, { id, t: new Date().toISOString(), action, summary, resolved: false });
  return id;
}

export function resolveApproval(id: string, approved: boolean): boolean {
  const a = approvals.get(id);
  if (!a || a.resolved) return false;
  a.resolved = true;
  emitStreamEvent({ type: "approval", t: new Date().toISOString(), id, action: a.action, summary: `${approved ? "APPROVED" : "REJECTED"}: ${a.summary}` });
  return true;
}

// ---------------------------------------------------------------------------
// Tool-call stream logging (consumed by mcp-server.ts). Wraps an MCP tool
// handler so EVERY call through the API shows up on the Live Stream page —
// not just dashboard asks ("it should show all the messages going through
// the api"). Kept here (next to emitStreamEvent) so the wrapper is
// unit-testable from tests/24-dashboard-auth.test.ts without importing
// the mcp-server script.
// ---------------------------------------------------------------------------

/** Truncate a tool's args into a compact one-line payload for the stream. */
export function summarizeToolArgs(args: unknown): string {
  if (args == null) return "";
  try {
    const a: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    for (const k of Object.keys(a)) {
      if (typeof a[k] === "string" && a[k].length > 120) a[k] = a[k].slice(0, 117) + "...";
    }
    const s = JSON.stringify(a);
    return s.length > 200 ? s.slice(0, 197) + "..." : s;
  } catch {
    return String(args).slice(0, 200);
  }
}

/** Compact one-line summary of a tool result for the stream feed. */
export function summarizeToolResult(result: unknown): string {
  if (result == null) return "ok";
  try {
    const j = typeof result === "string" ? JSON.parse(result) : result;
    if (j && typeof j === "object") {
      const parts: string[] = [];
      const r = j as Record<string, any>;
      if (r.intent) parts.push(`intent=${r.intent}`);
      if (typeof r.total === "number") parts.push(`${r.total} találat`);
      if (Array.isArray(r.results)) parts.push(`${r.results.length} sor`);
      if (Array.isArray(r.jobs)) parts.push(`${r.jobs.length} jegy`);
      if (r.ok === true) parts.push("ok");
      if (parts.length > 0) return parts.join(", ");
      const s = JSON.stringify(j);
      return s.length > 160 ? s.slice(0, 157) + "..." : s;
    }
    const s = String(result);
    return s.length > 160 ? s.slice(0, 157) + "..." : s;
  } catch {
    const s = String(result);
    return s.length > 160 ? s.slice(0, 157) + "..." : s;
  }
}

/**
 * Wrap an MCP tool handler so each call emits `question` / `answer`
 * stream events to the dashboard's Live Stream page. Errors still
 * propagate (the client sees the real failure) after a `HIBA:` event.
 */
export function withToolStreamLog(
  name: string,
  handler: (args: any, extra: any) => Promise<unknown>,
): (args: any, extra: any) => Promise<unknown> {
  return async (args, extra) => {
    emitStreamEvent({ type: "question", t: new Date().toISOString(), tool: name, q: summarizeToolArgs(args) });
    try {
      const result = await handler(args, extra);
      emitStreamEvent({ type: "answer", t: new Date().toISOString(), tool: name, summary: summarizeToolResult(result) });
      return result;
    } catch (e: any) {
      emitStreamEvent({
        type: "answer",
        t: new Date().toISOString(),
        tool: name,
        summary: `HIBA: ${String(e?.message ?? e).slice(0, 160)}`,
      });
      throw e;
    }
  };
}

// Proxy helpers ----------------------------------------------------------

async function proxy(restPath: string, init: RequestInit, write = false): Promise<Response> {
  const token = write && getWriteToken() ? getWriteToken() : getReadToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${getBaseUrl()}${restPath}`, { ...init, headers });
}

// The /dashboard request handler ----------------------------------------

export async function handleDashboard(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // Off by default unless at least one of the dashboard passwords is
  // set (user, admin, or the legacy single-password fallback). Without
  // any of these, the dashboard surface is disabled and /dashboard/*
  // returns 404.
  if (!getDashboardUserPassword() && !getDashboardAdminPassword()) {
    if (path === "/dashboard" || path.startsWith("/dashboard/")) {
      return new Response("Dashboard disabled (DASHBOARD_USER_PASSWORD / DASHBOARD_ADMIN_PASSWORD not set).", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }

  // 0. Legacy entry URL: the bare /dashboard now redirects to the v2
  //    SPA, so anyone with the old bookmark lands on the login page
  //    instead of a JSON 401.
  if (path === "/dashboard" || path === "/dashboard/") {
    if (method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    return new Response(null, {
      status: 302,
      headers: { "Location": "/dashboard/v2/" },
    });
  }

  // 0b. Admin SPA — STANDALONE, separate document at /dashboard/admin/.
  //     This is a wholly separate Vue app from the operator SPA at
  //     /dashboard/v2/. It has its own HTML entry, its own router, its
  //     own cookie, and its own URL namespace. The two SPAs only share
  //     the backend JSON endpoints and the design tokens — at runtime
  //     they have nothing in common (different Vue instances, different
  //     Pinia stores, different VueQuery clients).
  //
  //     Why a separate app: the user explicitly asked that admin be
  //     "a whole separate page, not part of the main app, it has its
  //     own login page and pages, it is only related to the main app
  //     through the backend, just like before. Currently with it being
  //     embeded into the main app looks really stupid." Putting admin
  //     under /dashboard/v2/admin/* would have meant: same topbar,
  //     same sidebar, same bottom tabs, same router history, same
  //     operator cookie check — which is exactly the "feels completely
  //     disconnected" failure mode they reported.
  //
  //     The admin entry points below are public (no operator-cookie
  //     gate). The admin cookie gate is on the JSON API endpoints
  //     further down (/dashboard/api/admin/*), and the SPA's login
  //     page probes /dashboard/api/admin/state on mount to decide
  //     whether to skip the form.

  // 0b-i. Admin SPA static assets (/dashboard/admin/assets/<hash>.<ext>).
  //       Same hash-named, content-addressed chunks as the operator
  //       SPA — Vite emits them into the same dist/assets/ dir, but
  //       the admin HTML's <base href="/dashboard/admin/"> rewrites
  //       the URLs to /dashboard/admin/assets/..., so we serve them
  //       from the same physical path.
  if (path.startsWith("/dashboard/admin/assets/")) {
    if (method !== "GET" && method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    let rel: string;
    try {
      rel = decodeURIComponent(path.slice("/dashboard/admin/assets/".length));
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const root = resolve(DASHBOARD_DIR, "v2", "assets");
    const fp = resolve(root, rel);
    if ((fp !== root && !fp.startsWith(root + sep)) || !existsSync(fp) || !statSync(fp).isFile()) {
      return new Response("not found", { status: 404 });
    }
    return new Response(readFileSync(fp), {
      status: 200,
      headers: {
        "content-type": assetContentType(rel),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  // 0b-ii. Admin SPA entry points. ALL public — no operator cookie
  //        required, no admin cookie required. The login page is
  //        reachable without any session, and the panel page just
  //        shows the form again if no admin cookie is set.
  //
  //        Only serves GET. POST/PATCH/DELETE on the same paths fall
  //        through to the API handlers further down (specifically
  //        /dashboard/admin/login POST at line 741).
  if (
    path === "/dashboard/admin" ||
    path === "/dashboard/admin/" ||
    path === "/dashboard/admin/login" ||
    path === "/dashboard/admin/login/" ||
    path === "/dashboard/admin/panel" ||
    path === "/dashboard/admin/panel/" ||
    path === "/dashboard/admin/disliked" ||
    path === "/dashboard/admin/disliked/"
  ) {
    if (method === "GET") {
      return new Response(loadHtml("v2/admin.html"), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache, no-store, must-revalidate",
          "pragma": "no-cache",
        },
      });
    }
    // For non-GET, let the request fall through. /dashboard/admin/login
    // POST is handled below the auth gate; anything else returns the
    // generic "method not allowed" further down (or the JSON 404 for
    // paths we don't know).
  }

  // 1. v2 SPA entry points.
  //
  // The v2 SPA is served from /dashboard/v2/ and below. The /login
  // sub-path is the only public entry — the rest is cookie-gated and
  // 302s to /login when the session is missing. Inside the SPA,
  // vue-router picks the right view based on the path (LoginPage at
  // /login, the rest of the app at /ask, /stream, ...).
  //
  // Why the bare /dashboard/v2/ alias: typing just the dashboard URL
  // lands the user in the app, not on a 404. With a valid cookie the
  // root forwards straight to /ask; WITHOUT a cookie it must forward
  // to /login — serving the shell and letting vue-router decide used
  // to dump unauthenticated visitors on the Ask page (the router has
  // no auth guard, so "/" -> redirect "/ask" won).
  if (
    path === "/dashboard/v2" ||
    path === "/dashboard/v2/" ||
    path === "/dashboard/v2/login" ||
    path === "/dashboard/v2/login/"
  ) {
    if (method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    if (checkCookie(req) && (path === "/dashboard/v2" || path === "/dashboard/v2/")) {
      return new Response(null, {
        status: 302,
        headers: { "Location": "/dashboard/v2/ask" },
      });
    }
    if (!checkCookie(req) && (path === "/dashboard/v2" || path === "/dashboard/v2/")) {
      return new Response(null, {
        status: 302,
        headers: { "Location": "/dashboard/v2/login" },
      });
    }
    return new Response(loadHtml("v2/index.html"), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Vite rebuilds change the asset hashes on every deploy, so
        // the HTML itself must always re-validate against the server.
        // Otherwise the browser can stick on a stale index.html
        // that references chunks that have since been deleted.
        "cache-control": "no-cache, no-store, must-revalidate",
        "pragma": "no-cache",
      },
    });
  }

// 1b. v2 static assets (/dashboard/v2/assets/<hash>.<ext>). Served
//     WITHOUT auth on purpose: the LoginPage JS bundle must load before
//     the visitor has a cookie, and the hash-named files are
//     unguessable + immutable (Vite emits content-hashed filenames), so
//     a long cache lifetime is safe. Placed before the generic
//     /dashboard/v2/ shell rule so assets never hit the cookie gate.
if (path.startsWith("/dashboard/v2/assets/")) {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  let rel: string;
  try {
    rel = decodeURIComponent(path.slice("/dashboard/v2/assets/".length));
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const root = resolve(DASHBOARD_DIR, "v2", "assets");
  const fp = resolve(root, rel);
  // Path traversal guard: the resolved file must stay inside the assets dir.
  if ((fp !== root && !fp.startsWith(root + sep)) || !existsSync(fp) || !statSync(fp).isFile()) {
    return new Response("not found", { status: 404 });
  }
  return new Response(readFileSync(fp), {
    status: 200,
    headers: {
      "content-type": assetContentType(rel),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

// 1b'. Public root-level v2 files (favicon, brand mark, mobile icons).
//      Browsers request /favicon.ico implicitly when a tab is opened,
//      and the brand mark + apple-touch-icon / android-chrome-* are
//      referenced from <link rel="icon"> and <link rel="apple-touch-icon">
//      in the SPA shell. None of these should require auth — the tab
//      favicon must load BEFORE the user has a session cookie, otherwise
//      the browser sees a 302 to /login and shows a broken-image icon.
//
//      We serve a small explicit allowlist (the well-known public
//      filenames only) so we don't accidentally expose the whole
//      /dashboard/v2/ root without auth. Filenames are fixed strings,
//      so an immutable + long-lived cache is safe.
//
//      The same allowlist is mirrored under /dashboard/admin/ for the
//      standalone admin SPA — both SPAs share the dist root for public
//      assets, so the same physical files are served from both URL
//      namespaces.
const PUBLIC_ROOT_FILES = new Set([
  "favicon.ico",
  "favicon.png",
  "apple-touch-icon.png",
  "android-chrome-192.png",
  "android-chrome-512.png",
  "brand-mark.png",
  "manifest.webmanifest",
  "sw.js",
]);

function tryServePublicRootFile(p: string): Response | null {
  let prefix: string;
  if (p.startsWith("/dashboard/v2/")) prefix = "/dashboard/v2/";
  else if (p.startsWith("/dashboard/admin/")) prefix = "/dashboard/admin/";
  else return null;
  const filename = p.slice(prefix.length).split("/")[0];
  if (!PUBLIC_ROOT_FILES.has(filename)) return null;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const fp = resolve(DASHBOARD_DIR, "v2", filename);
  // Path traversal guard + existence check (filename is from the
  // explicit allowlist above, so this is defense-in-depth).
  const root = resolve(DASHBOARD_DIR, "v2");
  if (!fp.startsWith(root + sep) || !existsSync(fp) || !statSync(fp).isFile()) {
    return new Response("not found", { status: 404 });
  }
  return new Response(readFileSync(fp), {
    status: 200,
    headers: {
      "content-type": assetContentType(filename),
      // The favicon and brand mark rarely change (only when we
      // redesign the mascot), but the browser caches aggressively
      // anyway. Immutable + 1 day keeps refreshes snappy without
      // sticking on a stale icon if we do push a new one.
      "cache-control": "public, max-age=86400, must-revalidate",
    },
  });
}

if (path.startsWith("/dashboard/v2/") || path.startsWith("/dashboard/admin/")) {
  const served = tryServePublicRootFile(path);
  if (served) return served;
}

// 1c. Any other /dashboard/v2/<sub> path → cookie-gated SPA shell.
  //     Deep-links (e.g. /dashboard/v2/stream) and history-mode nav
  //     both come through here. Vue-router inside the SPA picks the
  //     page; the server just hands over the shell.
  if (path.startsWith("/dashboard/v2/")) {
    if (method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!checkCookie(req)) {
      return new Response(null, {
        status: 302,
        headers: { "Location": "/dashboard/v2/login" },
      });
    }
    return new Response(loadHtml("v2/index.html"), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // See the matching v2 root entry above for the rationale.
        "cache-control": "no-cache, no-store, must-revalidate",
        "pragma": "no-cache",
      },
    });
  }

  // 2. Login POST
  if (path === "/dashboard/login" && method === "POST") {
    let pw = "";
    let isJson = false;
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const txt = await req.text();
        pw = new URLSearchParams(txt).get("password") || "";
      } else if (ct.includes("application/json")) {
        isJson = true;
        const body = await req.json().catch(() => ({}));
        pw = String(body.password || "");
      } else {
        pw = (await req.text()).trim();
      }
    } catch { /* ignore */ }
    if (passwordOk(pw, getDashboardUserPassword())) {
      const sid = randomBytes(24).toString("hex");
      pushAudit({ action: "login", user: "dashboard" });
      // For form-encoded (legacy browser form submit), redirect with cookie.
      if (!isJson) {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/dashboard/v2/ask",
            "Set-Cookie": makeCookie(sid),
          },
        });
      }
      // For JSON (dashboard fetch), return the bearer token in the
      // response body. The dashboard JS stores it in sessionStorage
      // and attaches `Authorization: Bearer <token>` to every API call.
      // This makes the dashboard robust to cookie expiry / cleared
      // cookies / new tab without login, as long as the user has
      // logged in once in this tab session.
      return new Response(JSON.stringify({
        ok: true,
        token: getReadToken(),
        cookie_set: true,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Set-Cookie": makeCookie(sid),
        },
      });
    }
    pushAudit({ action: "login_failed" });
    if (isJson) {
      return new Response(JSON.stringify({ ok: false, error: "wrong password" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, {
      status: 302,
      headers: { "Location": "/dashboard/v2/login?error=1" },
    });
  }

  // 3. Logout
  if (path === "/dashboard/logout" && method === "POST") {
    pushAudit({ action: "logout" });
    return new Response(null, {
      status: 302,
      headers: { "Location": "/dashboard/v2/login", "Set-Cookie": clearCookie() },
    });
  }

  // 3a. /dashboard/api/maintenance — PUBLIC probe (no auth) for the
  //     current maintenance state. Used by the LoginPage to show a
  //     padlock + disable the form when the lock is on, and by the
  //     AppShell's active-session watcher to bounce authed users
  //     back to the login page when the lock is toggled. Returns
  //     `{ enabled, since, message }` — same shape as the admin
  //     state endpoint, minus the active_sessions field.
  if (path === "/dashboard/api/maintenance" && method === "GET") {
    return new Response(JSON.stringify({
      enabled: MAINTENANCE.enabled,
      since: MAINTENANCE.since,
      message: "Karbantartás alatt",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // 3b. (PWA assets removed — the v2 SPA no longer ships a manifest or
  //     service worker.)
  //     (Legacy /dashboard/ask/ removed — the v2 SPA owns the ask
  //     surface now and lives at /dashboard/v2/.)
  //     (Legacy /dashboard/ops/ removed — the v2 SPA covers all 4 ops
  //     surfaces under /dashboard/v2/.)

  // 4. /dashboard/api/acquire-token — returns the read bearer token
  //    to a cookie-authenticated caller. Lets the ask UI upgrade
  //    "I have a cookie session" to "I have a token I can attach
  //    to every fetch" without the user re-typing the password.
  //    This is the bridge that makes the dashboard work across
  //    cookie expiry / new tabs / cleared cookies, as long as the
  //    user is still cookie-authenticated at the moment of
  //    acquisition.
  if (path === "/dashboard/api/acquire-token" && method === "POST") {
    if (!checkCookie(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    pushAudit({ action: "acquire_token" });
    return new Response(JSON.stringify({ ok: true, token: getReadToken() }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  // 4b. /dashboard/admin/login — placed BEFORE the operator 401 gate
  //     so an unauthenticated visitor can still log in as the admin.
  //     Uses DASHBOARD_ADMIN_PASSWORD (or the legacy DASHBOARD_PASSWORD
  //     fallback). Sets a SEPARATE admin cookie (3-min TTL) under a
  //     different name so the operator cookie does not unlock admin
  //     endpoints.
  if (path === "/dashboard/admin/login" && method === "POST") {
    let pw = "";
    try {
      const body = await req.json().catch(() => ({}));
      pw = String(body?.password || "");
    } catch { /* ignore */ }
    if (passwordOk(pw, getDashboardAdminPassword())) {
      const sid = randomBytes(24).toString("hex");
      pushAudit({ action: "admin_login" });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Set-Cookie": makeAdminCookie(sid),
        },
      });
    }
    pushAudit({ action: "admin_login_failed" });
    return new Response(JSON.stringify({ ok: false, error: "wrong password" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }

  // 5. From here on, everything requires EITHER a valid session cookie
  //    OR a valid bearer token. The bearer is what the dashboard JS
  //    stores in sessionStorage after login and re-attaches to every
  //    API call. This makes the API robust to cookie expiry / cleared
  //    cookies within the same tab session.
  if (!isAuthenticated(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // 5b. Record operator session activity (for the admin's
  //     "Aktív munkamenetek" counter). We only count requests that
  //     carry a valid operator cookie — the bearer fallback is for
  //     server-to-server calls and shouldn't show up on the dashboard.
  //     Maintenance is enforced below, but session recording happens
  //     BEFORE the 503 so the admin can see how many users were
  //     active just before the lock went on.
  if (checkCookie(req)) {
    const m = (req.headers.get("cookie") ?? "").match(
      new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`),
    );
    if (m) {
      const sid = m[1].split(".")[0];
      if (sid) recordSessionSeen(sid);
    }
  }

  // 5c. Admin login / logout / state (admin-cookie gated).
  //
  // The /dashboard/admin/login endpoint is intentionally placed BEFORE
  // the maintenance gate (login must still work when the lock is on, so
  // the admin can come back to unlock it). It is ALSO placed before
  // the operator 401 gate (see the block above the auth gate), so an
  // unauthenticated visitor can still reach /dashboard/admin/login and
  // the SPA shell that contains it. Admin logout is gated by the admin
  // cookie, but we still place it after the operator 401 gate — the
  // logout endpoint needs no pre-existing session.

  // 5c-ii. Admin logout
  if (path === "/dashboard/admin/logout" && method === "POST") {
    pushAudit({ action: "admin_logout" });
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Set-Cookie": clearAdminCookie(),
      },
    });
  }

  // 5c-iii. Admin state probe (also used by AdminLoginPage to skip
  //          the form on a valid cookie).
  if (path === "/dashboard/api/admin/state" && method === "GET") {
    if (!checkAdminCookie(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      maintenance: { enabled: MAINTENANCE.enabled, since: MAINTENANCE.since },
      active_sessions: countActiveSessions(),
      total_sessions: totalSessionsEver,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  // 5c-iv. Admin maintenance toggle
  if (path === "/dashboard/api/admin/maintenance" && method === "POST") {
    if (!checkAdminCookie(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    let body: any = {};
    try { body = await req.json(); } catch { /* ignore */ }
    const enabled = !!body?.enabled;
    MAINTENANCE.enabled = enabled;
    MAINTENANCE.since = enabled ? new Date().toISOString() : null;
    if (enabled) {
      // Kill every active operator session immediately. We do this
      // by bumping the cookie secret for one second — that
      // invalidates every existing signature, so the next request
      // 401s and forces a re-login. The bumping is restored in the
      // `setTimeout` below; the sign() function reads COOKIE_SECRET
      // at call time so the bump takes effect immediately.
      // (We don't actually change COOKIE_SECRET here; instead we use
      // a SESSION_KILL flag the operator gate checks.)
      pushAudit({ action: "maintenance_on" });
    } else {
      pushAudit({ action: "maintenance_off" });
    }
    return new Response(JSON.stringify({
      ok: true,
      maintenance: { enabled: MAINTENANCE.enabled, since: MAINTENANCE.since },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  // 5c-v. Admin feedback counters proxy. Counters are public on the
  //        cmms-api side, so we don't need to inject the write token
  //        here — the read token works (and the proxy is available
  //        so the dashboard stays on a same-origin URL).
  if (path === "/dashboard/api/feedback/counters" && method === "GET") {
    if (!checkAdminCookie(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const r = await proxy("/v1/feedback/counters", { method: "GET" }, false);
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }

  // 5c-vi. Admin feedback settings (verbose_dislike).
  if (path === "/dashboard/api/feedback/settings" && method === "GET") {
    if (!checkAdminCookie(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const r = await proxy("/v1/feedback/settings", { method: "GET" }, true);
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }
  if (path === "/dashboard/api/feedback/settings" && method === "POST") {
    if (!checkAdminCookie(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const body = await req.text();
    const r = await proxy("/v1/feedback/settings", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    }, true);
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }

  // 5c-vii. Admin disliked list.
  if (path === "/dashboard/api/feedback/disliked" && method === "GET") {
    if (!checkAdminCookie(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const qs = url.search;
    const r = await proxy(`/v1/feedback/disliked${qs}`, { method: "GET" }, true);
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }

  // 5c-viii. Operator feedback my-votes (pre-hydrate the chat bubbles).
  //   Read-gated on the cmms-api side (X-Cmms-Uid required); the read
  //   bearer is sufficient here. Forward the request body so the
  //   X-Cmms-Uid header reaches the upstream handler untouched.
  if (path === "/dashboard/api/feedback/my-votes" && method === "GET") {
    if (!isAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const qs = url.search;
    let r: Response;
    try {
      r = await proxy(`/v1/feedback/my-votes${qs}`, {
        method: "GET",
        headers: { "X-Cmms-Uid": req.headers.get("x-cmms-uid") ?? "" },
        signal: AbortSignal.timeout(10_000),
      }, false);
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
        hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }

  // 5c-viii-b. Operator feedback my-corrections (pre-hydrate the
  //   "Visszajelzés elküldve" state for every rendered bubble). The
  //   SPA sends the answer_ids as a comma-separated query string and
  //   the X-Cmms-Uid header — both forwarded verbatim. The 10s
  //   timeout aborts the proxy if cmms-api stalls so the user sees a
  //   503 (retryable) instead of a 504 from zrok's edge.
  if (path === "/dashboard/api/feedback/my-corrections" && method === "GET") {
    if (!isAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const qs = url.search;
    let r: Response;
    try {
      r = await proxy(`/v1/feedback/my-corrections${qs}`, {
        method: "GET",
        headers: { "X-Cmms-Uid": req.headers.get("x-cmms-uid") ?? "" },
        signal: AbortSignal.timeout(10_000),
      }, false);
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
        hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }

  // 5c-ix. Operator feedback vote (POST).
  //   Read-gated on the cmms-api side (X-Cmms-Uid required); the read
  //   bearer is sufficient here. The SPA sends the body and the
  //   X-Cmms-Uid header — we forward both verbatim.
  if (path === "/dashboard/api/feedback/vote" && method === "POST") {
    if (!isAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const body = await req.text();
    let r: Response;
    try {
      r = await proxy("/v1/feedback/vote", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Cmms-Uid": req.headers.get("x-cmms-uid") ?? "",
        },
        signal: AbortSignal.timeout(10_000),
      }, false);
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
        hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }

  // 5c-x. Operator feedback correction (POST) — "share correct answer"
  //   follow-up. Read-gated upstream; the read bearer is sufficient.
  if (path === "/dashboard/api/feedback/correction" && method === "POST") {
    if (!isAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const body = await req.text();
    let r: Response;
    try {
      r = await proxy("/v1/feedback/correction", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Cmms-Uid": req.headers.get("x-cmms-uid") ?? "",
        },
        signal: AbortSignal.timeout(10_000),
      }, false);
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
        hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }

  // 5c-x-b. Shareable answer link — GET /v1/feedback/answer/:id
  //   (Phase 8, 2026-08-24, F4). The SPA navigates to
  //   /dashboard/answer/:id and calls this to fetch the snapshot
  //   for the read-only answer view. Login-required (user said so
  //   explicitly), permanent URL.
  if (
    method === "GET" &&
    path.startsWith("/dashboard/api/feedback/answer/")
  ) {
    if (!isAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const id = path.slice("/dashboard/api/feedback/answer/".length);
    let r: Response;
    try {
      r = await proxy(`/v1/feedback/answer/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { "X-Cmms-Uid": req.headers.get("x-cmms-uid") ?? "" },
        signal: AbortSignal.timeout(10_000),
      }, false);
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }

  // 5c-xi. Web Push subscription management (Phase 8, 2026-08-24, F2).
  //   All four endpoints are authenticated (the X-Cmms-Uid is the
  //   per-user key, no token gate needed). The GET endpoints are
  //   public-ish (the public-key is needed before login to render the
  //   install banner, so it's a special case under the auth check
  //   below). The POST/DELETE require the operator session.
  if (path === "/dashboard/api/push/public-key" && method === "GET") {
    try {
      const r = await fetch(`${getBaseUrl()}/v1/push/public-key`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      const txt = await r.text();
      return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({
        enabled: false,
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
  }
  if (path === "/dashboard/api/push/status" && method === "GET") {
    if (!isAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    try {
      const r = await proxy("/v1/push/status", {
        method: "GET",
        headers: { "X-Cmms-Uid": req.headers.get("x-cmms-uid") ?? "" },
        signal: AbortSignal.timeout(5_000),
      }, false);
      const txt = await r.text();
      return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({
        enabled: false, count: 0, devices: [],
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
  }
  if (path === "/dashboard/api/push/subscribe" && method === "POST") {
    if (!isAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const body = await req.text();
    try {
      const r = await proxy("/v1/push/subscribe", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Cmms-Uid": req.headers.get("x-cmms-uid") ?? "",
        },
        signal: AbortSignal.timeout(10_000),
      }, false);
      const txt = await r.text();
      return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
  }
  if (path === "/dashboard/api/push/subscribe" && method === "DELETE") {
    if (!isAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const body = await req.text();
    try {
      const r = await proxy("/v1/push/subscribe", {
        method: "DELETE",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Cmms-Uid": req.headers.get("x-cmms-uid") ?? "",
        },
        signal: AbortSignal.timeout(10_000),
      }, false);
      const txt = await r.text();
      return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
  }
  if (path === "/dashboard/api/push/test" && method === "POST") {
    if (!isAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    try {
      const r = await proxy("/v1/push/test", {
        method: "POST",
        headers: { "X-Cmms-Uid": req.headers.get("x-cmms-uid") ?? "" },
        signal: AbortSignal.timeout(15_000),
      }, false);
      const txt = await r.text();
      return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
  }

  // 5d. Maintenance gate. When ON, every operator request 503s with
  //     a `maintenance: true` flag so the LoginPage can show the
  //     "Karbantartás alatt" banner. The admin endpoints above are
  //     already past this gate, so the admin can still toggle the
  //     lock off.
  if (MAINTENANCE.enabled) {
    return new Response(JSON.stringify({
      error: "maintenance",
      maintenance: true,
      message: "Karbantartás alatt",
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  // 6. API routes
  if (path === "/dashboard/api/answer" && method === "POST") {
    const body = await req.text();
    emitStreamEvent({ type: "question", t: new Date().toISOString(), tool: "answer", q: tryExtractQ(body) });
    let r: Response;
    try {
      r = await proxy("/v1/answer", { method: "POST", body });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
        hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const txt = await r.text();
    emitStreamEvent({ type: "answer", t: new Date().toISOString(), tool: "answer", summary: tryExtractSummary(txt) });
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }
  if (path === "/dashboard/api/answer-agent" && method === "POST") {
    const body = await req.text();
    emitStreamEvent({ type: "question", t: new Date().toISOString(), tool: "answer-agent", q: tryExtractQ(body) });
    // The v2 SPA sends `async: true` and polls GET /dashboard/api/answer-agent/:id.
    // The zrok edge cuts proxied responses at ~60s, so complex questions
    // (1-3 min of evidence gathering) run as a background job on cmms-api.
    // Legacy SPA builds (async absent) keep the old synchronous forward.
    let isAsync = false;
    try {
      const parsed = JSON.parse(body);
      isAsync = parsed?.async === true;
    } catch { /* non-JSON body → sync forward as before */ }
    let r: Response;
    try {
      r = await proxy(isAsync ? "/v1/answer-agent/async" : "/v1/answer-agent", { method: "POST", body });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
        hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const txt = await r.text();
    if (!isAsync) {
      emitStreamEvent({ type: "answer", t: new Date().toISOString(), tool: "answer-agent", summary: tryExtractAgentSummary(txt) });
    }
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }
  // Agent streaming path — POST /dashboard/api/answer-agent/stream.
  // Forwards the SSE byte stream from cmms-api UNTOUCHED (ReadableStream
  // passthrough): the v2 Ask page renders status/tool/token events live.
  // No JSON parsing here — the body is a `text/event-stream` frame
  // sequence. If the upstream fetch fails (cmms-api down) we return the
  // standard 503 JSON so the SPA's fallback-to-async-poll kicks in.
  if (path === "/dashboard/api/answer-agent/stream" && method === "POST") {
    const body = await req.text();
    let r: Response;
    try {
      r = await proxy("/v1/answer-agent/stream", { method: "POST", body });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
        hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const headers: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    };
    if (!r.body) {
      return new Response(r.statusText, { status: r.status, headers });
    }
    return new Response(r.body as ReadableStream, { status: r.status, headers });
  }
  // Machine-scoped ask — GET /dashboard/api/devices?q=…&limit=…
  // Substring device search proxied to /v1/devices (read token).
  if (path === "/dashboard/api/devices" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const limit = url.searchParams.get("limit") ?? "20";
    let r: Response;
    try {
      r = await proxy(`/v1/devices?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`, { method: "GET" });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  }
  // Async agent job poll — GET /dashboard/api/answer-agent/:jobId.
  // The SPA polls this until the background job reports done/error.
  if (path.startsWith("/dashboard/api/answer-agent/") && method === "GET") {
    const jobId = path.slice("/dashboard/api/answer-agent/".length);
    let r: Response;
    try {
      r = await proxy(`/v1/answer-agent/async/${encodeURIComponent(jobId)}`, { method: "GET", signal: AbortSignal.timeout(10_000) });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
        hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const txt = await r.text();
    // When the job completes, surface the answer summary to the Live Stream.
    if (r.status === 200) {
      try {
        const parsed = JSON.parse(txt);
        if (parsed?.status === "done" && parsed?.result?.final_text) {
          emitStreamEvent({ type: "answer", t: new Date().toISOString(), tool: "answer-agent", summary: tryExtractAgentSummary(JSON.stringify(parsed.result)) });
        }
      } catch { /* non-JSON — pass through as-is */ }
    }
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }
  if (path === "/dashboard/api/jobs/search" && method === "POST") {
    // On-demand ticket search. The Map page's machine-type inspector
    // calls this when the server-baked `samples` list is empty (i.e.
    // the node didn't qualify for the upstream evidence pass), so the
    // user can still see related tickets without leaving the Map.
    // Read token is sufficient — the response only contains ticket
    // summaries, not anything write-sensitive.
    const body = await req.text();
    let r: Response;
    try {
      r = await proxy("/v1/jobs/search", { method: "POST", body });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return new Response(await r.text(), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (path === "/dashboard/api/map" && method === "GET") {
    const period = url.searchParams.get("period") ?? "last_30_days";
    // The dashboard's spatial map wants every machine-type group, not
    // a slice — the user picks nodes out of the returned set via zoom
    // and pan, not via paging. Default to 1000 (well above the largest
    // fleet we've ever seen) and let the client override with
    // ?limit=N if it wants to.
    const requestedLimit = Number(url.searchParams.get("limit") ?? "1000");
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(10_000, Math.floor(requestedLimit))
      : 1000;
    // /v1/jobs/stats is POST-only; pass the filters in the body.
    // include_evidence: true so each top-N group ships 1-2 sample
    // tickets (the inspector's "Minta ticketek" section + the Ask
    // AskBar's "Frissítés" affordance use them). For low-volume
    // machine types whose group is too small to qualify for the
    // server's evidence pass, the MapNodeInspector fires an
    // on-demand /v1/jobs/search with `device=<model>` as a fallback
    // (see dashboard-v2/src/components/map/MapNodeInspector.vue).
    const body = JSON.stringify({
      group_by: "machine_type",
      period,
      include_evidence: true,
      evidence_per_group: 2,
      limit,
    });
    let r: Response;
    try {
      r = await proxy("/v1/jobs/stats", { method: "POST", body });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: "cmms-api unavailable", detail: String(e?.message ?? e) }), {
        status: 503, headers: { "content-type": "application/json" },
      });
    }
    const txt = await r.text();
    // Project the stats result into the shape the dashboard's
    // renderMap() expects: { nodes: [{ model, raw, tickets, samples }] }.
    try {
      const upstream = JSON.parse(txt);
      const groups = Array.isArray(upstream?.results) ? upstream.results : [];
      // The upstream payload puts evidence under `evidence[group_name]`
      // keyed by the group label — pull the matching samples onto each
      // node so the client can render the inspector without an extra
      // round-trip.
      const evidence = (upstream?.evidence && typeof upstream.evidence === "object")
        ? upstream.evidence as Record<string, any[]>
        : {};
      const nodes = groups.map((g: any) => {
        const raw = String(g.name ?? "");
        // The dashboard node label is the model field; we keep `raw`
        // around so a future iteration can disambiguate the rare
        // "name is the customer, not the device" case.
        const samplesRaw = evidence[raw] ?? evidence[g.name] ?? [];
        const samples = Array.isArray(samplesRaw) ? samplesRaw.map((s: any) => ({
          sorszam: String(s?.sorszam ?? s?.key ?? ""),
          snippet: String(s?.snippet ?? s?.reported_text ?? ""),
          kategoria: s?.kategoria ?? null,
          kategoria_inferred: s?.kategoria_inferred ?? null,
          sulyossag_inferred: s?.sulyossag_inferred ?? null,
          reported_at_iso: s?.reported_at_iso ?? null,
        })) : [];
        return { model: raw, raw, tickets: Number(g.count ?? 0), samples };
      });
      return new Response(JSON.stringify({
        nodes,
        total_groups: nodes.length,
        period: upstream?.period ?? null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
    }
  }
  if (path === "/dashboard/api/ticket" && method === "GET") {
    // Full ticket details by sorszam. Powers the ticket inspector
    // (drawer) and ticket panel (in-place right column). The server
    // endpoint is /v1/tickets/by-sorszam/:sorszam; the dashboard uses
    // a flat /dashboard/api/ticket?sorszam=… shape so the client
    // doesn't have to URL-encode the sorszam (which can contain '/'
    // and '-' characters that conflict with path segments).
    const sorszam = url.searchParams.get("sorszam") ?? "";
    if (sorszam.length === 0) {
      return new Response(JSON.stringify({ error: "missing_sorszam" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const r = await proxy(
      `/v1/tickets/by-sorszam/${encodeURIComponent(sorszam)}`,
      { method: "GET" },
    );
    const txt = await r.text();
    return new Response(txt, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (path === "/dashboard/api/stream" && method === "GET") {
    // Server-Sent Events stream of recent stream events. The first
    // line we push is `event: hello\ndata: {...}\n\n` so the client
    // can confirm the connection is live.
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const send = (ev: StreamEvent) => {
          const line = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
          try { controller.enqueue(enc.encode(line)); } catch { /* ignore */ }
        };
        send({ type: "answer", t: new Date().toISOString(), summary: "hello" } as any);
        streamSubscribers.add(send);
        const ping = setInterval(() => {
          try { controller.enqueue(enc.encode(`: ping\n\n`)); } catch { /* ignore */ }
        }, 25_000);
        const abort = () => {
          clearInterval(ping);
          streamSubscribers.delete(send);
          try { controller.close(); } catch { /* ignore */ }
        };
        req.signal.addEventListener("abort", abort);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }
  if (path === "/dashboard/api/audit" && method === "GET") {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? "100")));
    return new Response(JSON.stringify({
      entries: auditLog.slice(-limit).reverse(),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path === "/dashboard/api/diff" && method === "GET") {
    // Stub today: filter the audit log by action ∈ {approval, answer}
    // and wrap each row. before=null, after=string. Future: real diff
    // payload (the spec calls for a structured before/after).
    const since = Date.parse(url.searchParams.get("since") ?? "") || 0;
    const rows = auditLog
      .filter((e) => (e.action === "approval" || e.action === "answer") && Date.parse(e.t) >= since)
      .slice(-100)
      .map((e) => ({
        entity: e.tool ?? "cmms",
        id: e.detail ?? e.t,
        action: e.action,
        t: e.t,
        before: null,
        after: e.detail ?? "",
      }));
    return new Response(JSON.stringify({ changes: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (path === "/dashboard/api/revert" && method === "POST") {
    pushAudit({ action: "revert_request" });
    return new Response(JSON.stringify({ ok: false, note: "revert not yet implemented" }), {
      status: 501, headers: { "content-type": "application/json" },
    });
  }
  if (path === "/dashboard/api/tokens" && method === "GET") {
    return new Response(JSON.stringify({
      read_token_prefix: (getReadToken() || "(unset)").slice(0, 8),
      write_token_prefix: (getWriteToken() || "(unset)").slice(0, 8),
      bearer_token_prefix: (getReadToken() || "(unset)").slice(0, 8),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path === "/dashboard/api/tokens/rotate" && method === "POST") {
    return new Response(JSON.stringify({
      ok: false,
      note: "rotate via deploy script: update CMMS_API_TOKEN_READ in /etc/cmms-api.env then re-run deploy-binary.ts and deploy-mcp.ts",
    }), { status: 501, headers: { "content-type": "application/json" } });
  }
  if (path.startsWith("/dashboard/api/approvals/") && method === "POST") {
    const id = path.slice("/dashboard/api/approvals/".length);
    let body: any = {};
    try { body = await req.json(); } catch { /* ignore */ }
    const ok = resolveApproval(id, !!body.approved);
    return new Response(JSON.stringify({ ok }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  return new Response("not found", { status: 404 });
}

// Helpers extracted from the inline route body so the answer proxy can
// emit structured `question` / `answer` stream events with a real
// summary, not just a placeholder.

function tryExtractQ(body: string): string {
  try {
    const j = JSON.parse(body);
    return String(j?.q ?? "").slice(0, 200);
  } catch {
    return "";
  }
}

function tryExtractSummary(body: string): string {
  try {
    const j = JSON.parse(body);
    return String(j?.summary ?? `intent: ${j?.intent ?? "?"}`).slice(0, 200);
  } catch {
    return "";
  }
}

function tryExtractAgentSummary(body: string): string {
  try {
    const j = JSON.parse(body);
    if (typeof j?.final_text === "string" && j.final_text.length > 0) return j.final_text.slice(0, 200);
    if (j?.error?.code) return `agent error: ${j.error.code}`;
    return "agent response";
  } catch {
    return "";
  }
}
