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
import { join } from "node:path";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

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

  // 1. v2 SPA entry points.
  //
  // The v2 SPA is served from /dashboard/v2/ and below. The /login
  // sub-path is the only public entry — the rest is cookie-gated and
  // 302s to /login when the session is missing. Inside the SPA,
  // vue-router picks the right view based on the path (LoginPage at
  // /login, the rest of the app at /ask, /stream, ...).
  //
  // Why the bare /dashboard/v2/ alias: typing just the dashboard URL
  // lands the user in the app, not on a 404. Vue-router then redirects
  // to /login (no cookie) or /ask (cookie).
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
    return new Response(loadHtml("v2/index.html"), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 1b. Any other /dashboard/v2/<sub> path → cookie-gated SPA shell.
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
      headers: { "content-type": "text/html; charset=utf-8" },
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
  if (path === "/dashboard/api/map" && method === "GET") {
    const period = url.searchParams.get("period") ?? "last_30_days";
    // /v1/jobs/stats is POST-only; pass the filters in the body.
    const body = JSON.stringify({ group_by: "machine_type", period, include_evidence: false, limit: 20 });
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
