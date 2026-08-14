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
//   DASHBOARD_PASSWORD        - the password the user must enter on the
//                               login page
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
function checkCookie(req: Request): boolean {
  if (!process.env.DASHBOARD_PASSWORD) return false;
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

  // Off by default unless DASHBOARD_PASSWORD is set
  if (!process.env.DASHBOARD_PASSWORD) {
    if (path === "/dashboard" || path.startsWith("/dashboard/")) {
      return new Response("Dashboard disabled (DASHBOARD_PASSWORD not set).", { status: 404 });
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
    if (passwordOk(pw, process.env.DASHBOARD_PASSWORD!)) {
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
    const body = JSON.stringify({ group_by: "machine_type", period, include_evidence: false, limit });
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
    // renderMap() expects: { nodes: [{ model, raw, tickets }] }.
    try {
      const upstream = JSON.parse(txt);
      const groups = Array.isArray(upstream?.results) ? upstream.results : [];
      const nodes = groups.map((g: any) => {
        const raw = String(g.name ?? "");
        // The dashboard node label is the model field; we keep `raw`
        // around so a future iteration can disambiguate the rare
        // "name is the customer, not the device" case.
        return { model: raw, raw, tickets: Number(g.count ?? 0) };
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
