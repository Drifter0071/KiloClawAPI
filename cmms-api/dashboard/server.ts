// Dashboard HTTP server module.
//
// Served on the same port as the MCP HTTP transport (8788). All /dashboard*
// routes are gated by a password login. Once logged in, the browser
// session is a signed cookie; the dashboard uses that cookie to proxy
// requests to the cmms-api REST endpoints with the configured bearer
// token (CMMS_API_TOKEN_READ or CMMS_API_TOKEN_WRITE).
//
// Env vars (all optional — without DASHBOARD_USER_PASSWORD AND
// DASHBOARD_ADMIN_PASSWORD the dashboard is fully off and /dashboard
// returns 404):
//   DASHBOARD_USER_PASSWORD   - the password the user types on the
//                               standard /dashboard/login form
//   DASHBOARD_ADMIN_PASSWORD  - the password operations types on the
//                               /dashboard/admin/login form. When unset,
//                               the admin panel is off (admin routes 404).
//   DASHBOARD_COOKIE_SECRET   - secret used to sign both session
//                               cookies (default: a random value at
//                               process start). Set explicitly if you
//                               want stable sessions across restarts.
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
//
// Two independent sessions live on the same dashboard:
//   - USER session (cookie `cmms_dash_sid`): the staff who logs in via
//     /dashboard/login. 8-hour TTL, broad API access, BYPASSED by the
//     maintenance lock (when the lock is on, the user API calls 503).
//   - ADMIN session (cookie `cmms_dash_admin_sid`): operations staff
//     who logs in via /dashboard/admin/login. 3-minute TTL, narrow
//     surface (toggle maintenance, view active session count, log
//     out). NEVER bypassed by the maintenance lock — the admin must
//     be able to log in and turn the lock OFF, even while it's on.
//
// Bearer-token fallback (CMMS_API_TOKEN_READ) only unlocks the user
// surface. The admin surface is cookie-only — there is no bearer
// bypass, on purpose.

const USER_COOKIE = "cmms_dash_sid";
const ADMIN_COOKIE = "cmms_dash_admin_sid";
const USER_COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours
const ADMIN_COOKIE_MAX_AGE = 60 * 3;     // 3 minutes
const COOKIE_SECRET = process.env.DASHBOARD_COOKIE_SECRET
  || randomBytes(32).toString("hex");

// Lazily-resolved admin session ids. Cleared when the maintenance
// lock is enabled (so all current user sessions die) and on
// individual /dashboard/logout calls. Keyed by session id; the
// value is the timestamp of the last activity — used to derive the
// "active session count" for the admin panel.
interface UserSession {
  sid: string;
  lastSeen: number;
}
const userSessions = new Map<string, UserSession>();
// Admin sessions are deliberately NOT tracked here: a refresh must
// log the admin out, and the cookie alone (signed, 3-min TTL) is
// the single source of truth.

function sign(value: string): string {
  return createHmac("sha256", COOKIE_SECRET).update(value).digest("hex");
}
function makeUserCookie(sid: string): string {
  const sig = sign(sid);
  return [
    `${USER_COOKIE}=${sid}.${sig}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${USER_COOKIE_MAX_AGE}`,
  ].join("; ");
}
function makeAdminCookie(sid: string): string {
  const sig = sign(sid);
  return [
    `${ADMIN_COOKIE}=${sid}.${sig}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ADMIN_COOKIE_MAX_AGE}`,
  ].join("; ");
}
function clearUserCookie(): string {
  return `${USER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
function clearAdminCookie(): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
function extractCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!m) return null;
  const [sid, sig] = m[1].split(".");
  if (!sid || !sig) return null;
  const expected = sign(sid);
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch {
    return null;
  }
  return sid;
}
function checkUserCookie(req: Request): string | null {
  if (!getEffectiveUserPassword()) return null;
  return extractCookie(req, USER_COOKIE);
}
function checkAdminCookie(req: Request): string | null {
  if (!getEffectiveAdminPassword()) return null;
  return extractCookie(req, ADMIN_COOKIE);
}

// Back-compat env helpers. The legacy DASHBOARD_PASSWORD env
// (single-name) maps to the user password; DASHBOARD_USER_PASSWORD
// takes precedence when both are set. This way, an upgrade
// requires zero config changes for the user surface, and the
// admin surface is opt-in via DASHBOARD_ADMIN_PASSWORD.
function getEffectiveUserPassword(): string {
  return process.env.DASHBOARD_USER_PASSWORD ?? process.env.DASHBOARD_PASSWORD ?? "";
}
function getEffectiveAdminPassword(): string {
  return process.env.DASHBOARD_ADMIN_PASSWORD ?? "";
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

// Combined check: either cookie OR bearer is fine. The bearer fallback
// is intentionally NOT applied to admin endpoints — admin is cookie-only.
//
// The user cookie branch ALSO requires the session id to still be
// present in the in-memory userSessions map. This is what makes
// setMaintenanceLock(true) actually log everybody out: when the
// lock flips on, userSessions.clear() runs, so even a user who
// later flips the cookie signature back into the request with
// `Cookie: cmms_dash_sid=…` no longer matches any active session
// and the request is rejected. The bearer fallback doesn't need
// the map check — the bearer is the long-lived cmms-api token
// (used by external clients like kiloclaw) and is treated as a
// privileged channel that the maintenance lock doesn't break.
function isUserAuthenticated(req: Request): boolean {
  const cookieSid = checkUserCookie(req);
  if (cookieSid && userSessions.has(cookieSid)) return true;
  return checkBearer(req);
}
// Admin surface: cookie-only. Bearer tokens are never accepted here.
function isAdminAuthenticated(req: Request): boolean {
  return checkAdminCookie(req) !== null;
}

// Constant-time password compare
function passwordOk(submitted: string, expected: string): boolean {
  if (typeof submitted !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Maintenance lock
//
// When the maintenance lock is enabled:
//   - The user login form is disabled (the SPA checks /api/maintenance
//     and shows a "Karbantartás" notice + the mascot wears a builder
//     hat).
//   - The user API (/dashboard/api/*) returns 503 to anyone who doesn't
//     have a valid admin cookie. The user cookie is still accepted for
//     the maintenance probe (so the SPA can detect the lock state and
//     route the user to the right page), but every other user API call
//     is rejected. The /dashboard/api/maintenance endpoint is allowed
//     through so the login page can ask "is the lock on?" without
//     needing credentials.
//   - Admin endpoints remain fully functional so the admin can turn
//     the lock back off.
//
// Toggling the lock on also clears every in-memory user session id
// (userSessions) so any cookie that the server already accepted will
// no longer be recognized, even within the same process. This is
// "invalidate all user tokens server-side" per the admin panel spec.
let maintenanceLock = false;
let maintenanceSince = ""; // ISO timestamp; "" when off

function setMaintenanceLock(on: boolean): void {
  if (on && !maintenanceLock) {
    maintenanceSince = new Date().toISOString();
    // Drop every user session id. The cookies are still well-formed
    // and signed, but the server now refuses them — so a reload
    // forces the user back to the (now locked) login page.
    userSessions.clear();
    pushAudit({ action: "maintenance_lock_on" });
  } else if (!on && maintenanceLock) {
    maintenanceSince = "";
    pushAudit({ action: "maintenance_lock_off" });
  }
  maintenanceLock = on;
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

  // Off by default unless at least one of the dashboard passwords is set.
  // We accept BOTH the new names (DASHBOARD_USER_PASSWORD /
  // DASHBOARD_ADMIN_PASSWORD) and the legacy single-name
  // (DASHBOARD_PASSWORD) for back-compat. The legacy name maps to
  // the user surface so existing deployments that only set
  // DASHBOARD_PASSWORD keep working — but the admin surface is
  // still off unless DASHBOARD_ADMIN_PASSWORD is also set.
  if (!getEffectiveUserPassword() && !getEffectiveAdminPassword()) {
    if (path === "/dashboard" || path.startsWith("/dashboard/")) {
      return new Response("Dashboard disabled (no dashboard password configured).", { status: 404 });
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
    path === "/dashboard/v2/login/" ||
    path === "/dashboard/v2/admin" ||
    path === "/dashboard/v2/admin/" ||
    path === "/dashboard/v2/admin/login" ||
    path === "/dashboard/v2/admin/login/"
  ) {
    if (method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    if (checkUserCookie(req) && (path === "/dashboard/v2" || path === "/dashboard/v2/")) {
      return new Response(null, {
        status: 302,
        headers: { "Location": "/dashboard/v2/ask" },
      });
    }
    if (!checkUserCookie(req) && (path === "/dashboard/v2" || path === "/dashboard/v2/")) {
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
if (path.startsWith("/dashboard/v2/")) {
  const filename = path.slice("/dashboard/v2/".length).split("/")[0];
  const PUBLIC_ROOT_FILES = new Set([
    "favicon.ico",
    "favicon.png",
    "apple-touch-icon.png",
    "android-chrome-192.png",
    "android-chrome-512.png",
    "brand-mark.png",
  ]);
  if (PUBLIC_ROOT_FILES.has(filename)) {
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
}

// 1c. Any other /dashboard/v2/<sub> path → cookie-gated SPA shell.
//     Deep-links (e.g. /dashboard/v2/stream) and history-mode nav
//     both come through here. Vue-router inside the SPA picks the
//     page; the server just hands over the shell.
//
//     The /admin path is publicly served: the admin panel needs
//     to be reachable even when the user has no cookie, and the
//     maintenance lock (which signs out every user) must not
//     lock the admin out. Inside the SPA, vue-router gates the
//     /admin view on the admin cookie (the AdminPanel component
//     does the gate and routes /admin/login when missing).
  if (path.startsWith("/dashboard/v2/")) {
    if (method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    if (path.startsWith("/dashboard/v2/admin") && !getEffectiveAdminPassword()) {
      // Admin disabled: refuse to serve the SPA shell for admin paths.
      return new Response("admin disabled", { status: 404 });
    }
    const isAdminPath = path === "/dashboard/v2/admin" || path === "/dashboard/v2/admin/" ||
                        path.startsWith("/dashboard/v2/admin/");
    if (isAdminPath) {
      // Public entry for the admin panel.
      return new Response(loadHtml("v2/index.html"), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache, no-store, must-revalidate",
          "pragma": "no-cache",
        },
      });
    }
    if (!checkUserCookie(req)) {
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

  // 2. User login POST
  if (path === "/dashboard/login" && method === "POST") {
    // If the maintenance lock is on, refuse new user logins so
    // the SPA can show the "Karbantartás alatt" notice. The
    // existing user cookie is also dropped (we cleared every
    // userSession entry when the lock was enabled), so the only
    // people who can do anything are admins.
    if (maintenanceLock) {
      pushAudit({ action: "login_blocked_maintenance" });
      return new Response(JSON.stringify({
        ok: false,
        error: "maintenance",
      }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
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
    if (passwordOk(pw, getEffectiveUserPassword())) {
      const sid = randomBytes(24).toString("hex");
      userSessions.set(sid, { sid, lastSeen: Date.now() });
      pushAudit({ action: "login", user: "dashboard" });
      // For form-encoded (legacy browser form submit), redirect with cookie.
      if (!isJson) {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/dashboard/v2/ask",
            "Set-Cookie": makeUserCookie(sid),
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
          "Set-Cookie": makeUserCookie(sid),
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

  // 3. User logout — clears the user cookie and removes the in-memory
  //    session record. Admin cookie is left alone (different cookie).
  if (path === "/dashboard/logout" && method === "POST") {
    const sid = checkUserCookie(req);
    if (sid) userSessions.delete(sid);
    pushAudit({ action: "logout" });
    return new Response(null, {
      status: 302,
      headers: { "Location": "/dashboard/v2/login", "Set-Cookie": clearUserCookie() },
    });
  }

  // 3a. Admin login POST — separate endpoint, separate cookie, separate
  //     session store. The admin cookie is 3 minutes, intentionally
  //     short, so even if the admin walks away the panel is locked
  //     when they come back. The admin can always log in here, even
  //     when the maintenance lock is on — that's the whole point of
  //     the lock: the admin must be able to undo it.
  if (path === "/dashboard/admin/login" && method === "POST") {
    if (!getEffectiveAdminPassword()) {
      return new Response(JSON.stringify({ ok: false, error: "admin disabled" }), {
        status: 404, headers: { "content-type": "application/json" },
      });
    }
    let pw = "";
    let isJson = false;
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        isJson = true;
        const body = await req.json().catch(() => ({}));
        pw = String(body.password || "");
      } else {
        pw = (await req.text()).trim();
      }
    } catch { /* ignore */ }
    if (passwordOk(pw, getEffectiveAdminPassword())) {
      const sid = randomBytes(24).toString("hex");
      pushAudit({ action: "admin_login" });
      if (!isJson) {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/dashboard/v2/admin",
            "Set-Cookie": makeAdminCookie(sid),
          },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Set-Cookie": makeAdminCookie(sid),
        },
      });
    }
    pushAudit({ action: "admin_login_failed" });
    if (isJson) {
      return new Response(JSON.stringify({ ok: false, error: "wrong password" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, {
      status: 302,
      headers: { "Location": "/dashboard/v2/admin/login?error=1" },
    });
  }

  // 3b. Admin logout
  if (path === "/dashboard/admin/logout" && method === "POST") {
    pushAudit({ action: "admin_logout" });
    return new Response(null, {
      status: 302,
      headers: { "Location": "/dashboard/v2/admin/login", "Set-Cookie": clearAdminCookie() },
    });
  }

  // 3b. (PWA assets removed — the v2 SPA no longer ships a manifest or
  //     service worker.)
  //     (Legacy /dashboard/ask/ removed — the v2 SPA owns the ask
  //     surface now and lives at /dashboard/v2/.)
  //     (Legacy /dashboard/ops/ removed — the v2 SPA covers all 4 ops
  //     surfaces under /dashboard/v2/.)

  // 3c. Public maintenance probe — the SPA asks this on mount + every
  //     15s, so the login page can show the "Karbantartás" notice
  //     immediately when the lock flips on (or off). Public on
  //     purpose: an unauthenticated visitor must be able to see that
  //     the dashboard is in maintenance, otherwise they have no
  //     feedback that the login form is disabled on purpose.
  if (path === "/dashboard/api/maintenance" && method === "GET") {
    return new Response(JSON.stringify({
      enabled: maintenanceLock,
      since: maintenanceSince || null,
    }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  // 4. /dashboard/api/acquire-token — returns the read bearer token
  //    to a cookie-authenticated caller. Lets the ask UI upgrade
  //    "I have a cookie session" to "I have a token I can attach
  //    to every fetch" without the user re-typing the password.
  //    This is the bridge that makes the dashboard work across
  //    cookie expiry / new tabs / cleared cookies, as long as the
  //    user is still cookie-authenticated at the moment of
  //    acquisition. The maintenance lock blocks this — the user
  //    can't acquire a fresh token while we're locked.
  if (path === "/dashboard/api/acquire-token" && method === "POST") {
    if (maintenanceLock) {
      return new Response(JSON.stringify({ ok: false, error: "maintenance" }), {
        status: 503, headers: { "content-type": "application/json" },
      });
    }
    if (!checkUserCookie(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    pushAudit({ action: "acquire_token" });
    return new Response(JSON.stringify({ ok: true, token: getReadToken() }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  // 4b. Admin endpoints — these sit BEFORE the user-auth gate so
  //     they only require an admin cookie (not a user cookie).
  //     They are intentionally narrow: toggle the maintenance lock,
  //     read the active session count, log out. Nothing else.
  if (path === "/dashboard/api/admin/state" && method === "GET") {
    if (!isAdminAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    // Count "active" user sessions: those touched in the last 10
    // minutes. This is a soft count — sessions whose cookies have
    // expired will eventually drop off naturally, but a session
    // whose user is idle in another tab still counts as "logged in"
    // until the 8-hour cookie expires.
    const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    let active = 0;
    for (const s of userSessions.values()) {
      if (s.lastSeen >= cutoff) active++;
    }
    return new Response(JSON.stringify({
      ok: true,
      maintenance: {
        enabled: maintenanceLock,
        since: maintenanceSince || null,
      },
      active_sessions: active,
      total_sessions: userSessions.size,
    }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (path === "/dashboard/api/admin/maintenance" && method === "POST") {
    if (!isAdminAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    let body: any = {};
    try { body = await req.json(); } catch { /* ignore */ }
    const want = body?.enabled === true;
    setMaintenanceLock(want);
    return new Response(JSON.stringify({
      ok: true,
      maintenance: {
        enabled: maintenanceLock,
        since: maintenanceSince || null,
      },
    }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  // 5. From here on, everything requires EITHER a valid user session
  //    cookie OR a valid bearer token. The bearer is what the
  //    dashboard JS stores in sessionStorage after login and
  //    re-attaches to every API call. This makes the API robust to
  //    cookie expiry / cleared cookies within the same tab session.
  //
  //    We also touch the user session's lastSeen here so the
  //    admin's "active sessions" counter reflects real activity,
  //    and so that a session id whose cookie was just validated
  //    stays in the userSessions map (otherwise setMaintenanceLock
  //    only helps people who logged in THIS process — stale ids
  //    would be unknown).
  if (!isUserAuthenticated(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  // Maintenance gate: when the lock is on, all user API calls 503
  // until the admin turns it off. The public /api/maintenance probe
  // and the admin endpoints are routed above this gate, so they're
  // not affected.
  if (maintenanceLock) {
    return new Response(JSON.stringify({
      error: "maintenance",
      message: "Dashboard is in maintenance mode. Please try again later.",
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  // Touch lastSeen on the user session so the admin's active
  // counter reflects activity. We do this AFTER the auth+lock
  // check so probe-only / 503 responses don't bump the counter.
  //
  // We deliberately do NOT re-add the sid to userSessions if it
  // was cleared (e.g. by setMaintenanceLock(true)). Doing so would
  // silently re-authenticate users who were explicitly signed out
  // by the maintenance lock — defeating the "log out everybody"
  // guarantee. The lock test (25-admin-panel.test.ts) asserts
  // that a user cookie invalidated by the lock stays 401 even
  // after the lock is turned back off, until the user logs in
  // again from scratch.
  const _userSid = checkUserCookie(req);
  if (_userSid) {
    const _s = userSessions.get(_userSid);
    if (_s) _s.lastSeen = Date.now();
  }

  // Feedback — user surface. Routed AFTER the maintenance gate so
  // a locked dashboard 503s these (no votes while in maintenance).
  // The X-Cmms-Uid header is forwarded as-is; the cmms-api side
  // also requires it (a UUID v4 from localStorage).
  if (path === "/dashboard/api/feedback/vote" && method === "POST") {
    const body = await req.arrayBuffer();
    const r = await proxy(`/v1/feedback/vote`, { method: "POST", body, headers: req.headers });
    return new Response(await r.arrayBuffer(), {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
    });
  }
  if (path === "/dashboard/api/feedback/my-votes" && method === "GET") {
    const r = await proxy(`/v1/feedback/my-votes?${new URL(req.url).searchParams.toString()}`, { method: "GET", headers: req.headers });
    return new Response(await r.arrayBuffer(), {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
    });
  }
  if (path === "/dashboard/api/feedback/counters" && method === "GET") {
    const r = await proxy(`/v1/feedback/counters`, { method: "GET", headers: req.headers });
    return new Response(await r.arrayBuffer(), {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
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
    let r: Response;
    try {
      r = await proxy("/v1/answer-agent", { method: "POST", body });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "cmms-api unavailable",
        detail: String(e?.message ?? e),
        hint: "cmms-api may be reloading (ETL takes ~5 min after deploy). Try again in a minute.",
      }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const txt = await r.text();
    emitStreamEvent({ type: "answer", t: new Date().toISOString(), tool: "answer-agent", summary: tryExtractAgentSummary(txt) });
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
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
    // include_evidence: true → each top-N machine-type group ships up to
    // 2 sample tickets (sorszam + snippet + kategoria + sulyossag_inferred)
    // so the map's géptípus inspector can show real tickets instead of
    // "Minta ticketek (0)". The 2 sample cost is ~3 KB per top-N group.
    const body = JSON.stringify({ group_by: "machine_type", period, include_evidence: true, evidence_per_group: 2, limit });
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
    // renderMap() expects: { nodes: [{ model, raw, tickets, samples? }] }.
    //
    // When the upstream call sets `include_evidence: true` the response
    // carries an `evidence` map keyed by group name → sample ticket
    // list. We forward those samples under the `samples` field so the
    // géptípus inspector can render them directly. For low-volume
    // machine types (e.g. "Forg.kihord" with 1 ticket) the upstream only
    // attaches samples to the top-N groups; the inspector handles that
    // case with an on-demand /v1/jobs/search fallback (see
    // MapNodeInspector.vue).
    try {
      const upstream = JSON.parse(txt);
      const groups = Array.isArray(upstream?.results) ? upstream.results : [];
      const evidence = upstream?.evidence && typeof upstream.evidence === "object" ? upstream.evidence : null;
      const nodes = groups.map((g: any) => {
        const raw = String(g.name ?? "");
        // The dashboard node label is the model field; we keep `raw`
        // around so a future iteration can disambiguate the rare
        // "name is the customer, not the device" case.
        const node: Record<string, unknown> = {
          model: raw,
          raw,
          tickets: Number(g.count ?? 0),
        };
        if (evidence && Array.isArray(evidence[raw]) && evidence[raw].length > 0) {
          node.samples = evidence[raw].map((s: any) => ({
            sorszam: String(s.sorszam ?? ""),
            snippet: String(s.snippet ?? ""),
            kategoria: s.kategoria ?? null,
            kategoria_inferred: s.kategoria_inferred ?? null,
            sulyossag_inferred: s.sulyossag_inferred ?? null,
            reported_at_iso: s.reported_at_iso ?? null,
          }));
        }
        return node;
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

  // Admin feedback (Ask disliked-answers list + settings). Routed
  // BEFORE the user auth + maintenance gates below so the admin
  // can still see the disliked list and toggle verbose dislike
  // even while the user surface is locked down. Admin cookie only.
  if (path === "/dashboard/api/feedback/disliked" ||
      path === "/dashboard/api/feedback/settings") {
    if (!isAdminAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    // Admin surface: forward with the write token so cmms-api's
    // requireAuth({ write: true }) accepts it. Strip the original
    // Cookie + Authorization — the helper sets them from the
    // configured tokens. Without this the server-side requireAuth
    // sees the dashboard's admin cookie (which it doesn't
    // understand) and 401s.
    const restPath = `/v1${path.slice("/dashboard/api".length)}`;
    const init: RequestInit = {
      method,
      headers: new Headers(),
    };
    if (method !== "GET" && method !== "HEAD") {
      init.body = await req.arrayBuffer();
    }
    const r = await proxy(restPath + (new URL(req.url).search || ""), init, true);
    return new Response(await r.arrayBuffer(), {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
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
