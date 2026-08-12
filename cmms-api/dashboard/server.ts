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
//   GET  /dashboard           - login page OR dashboard if cookie valid
//   POST /dashboard/login     - check password, set cookie, redirect
//   POST /dashboard/logout    - clear cookie
//   GET  /dashboard/api/answer  - POST {q} -> /v1/answer (read)
//   GET  /dashboard/api/map     - GET ?period=... -> aggregated device stats
//   GET  /dashboard/api/stream   - SSE stream of recent questions / approvals
//   GET  /dashboard/api/audit    - audit log
//   POST /dashboard/api/tokens/rotate - rotate the read bearer token
//   GET  /dashboard/api/diff     - ?since=ISO -> list of recent changes
//   POST /dashboard/api/revert   - {entity, id} -> revert one change
//   POST /dashboard/api/approvals/:id - {approved: bool} - approval queue
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

const BASE = process.env.CMMS_API_URL ?? "http://127.0.0.1:8787";
const READ_TOKEN = process.env.CMMS_API_TOKEN_READ ?? "";
const WRITE_TOKEN = process.env.CMMS_API_TOKEN_WRITE ?? "";

async function proxy(restPath: string, init: RequestInit, write = false): Promise<Response> {
  const token = write && WRITE_TOKEN ? WRITE_TOKEN : READ_TOKEN;
  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${BASE}${restPath}`, { ...init, headers });
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

  // 1. Login page (GET /dashboard or /dashboard/login GET) — public
  if (path === "/dashboard" || (path === "/dashboard/login" && method === "GET")) {
    if (checkCookie(req)) {
      // Redirect to the new mobile-first ask surface.
      return new Response(null, {
        status: 302,
        headers: { "Location": "/dashboard/ask/" },
      });
    }
    return new Response(loadHtml("login.html"), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 1b. Legacy 4-tab ops dashboard at /dashboard/ops/.
  //     This is the "Live Stream + Spatial Map + Diff/Revert + Token Portal"
  //     surface that pre-dates the Ask UI. Cookie-gated.
  if (path === "/dashboard/ops/" || path === "/dashboard/ops") {
    if (!checkCookie(req)) {
      return new Response(null, { status: 302, headers: { "Location": "/dashboard" } });
    }
    return new Response(loadHtml("dashboard.html"), {
      status: 200, headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 2. Login POST
  if (path === "/dashboard/login" && method === "POST") {
    let pw = "";
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const txt = await req.text();
        pw = new URLSearchParams(txt).get("password") || "";
      } else if (ct.includes("application/json")) {
        const body = await req.json().catch(() => ({}));
        pw = String(body.password || "");
      } else {
        pw = (await req.text()).trim();
      }
    } catch { /* ignore */ }
    if (passwordOk(pw, process.env.DASHBOARD_PASSWORD!)) {
      const sid = randomBytes(24).toString("hex");
      pushAudit({ action: "login", user: "dashboard" });
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/dashboard",
          "Set-Cookie": makeCookie(sid),
        },
      });
    }
    pushAudit({ action: "login_failed" });
    return new Response(null, {
      status: 302,
      headers: { "Location": "/dashboard?error=1" },
    });
  }

  // 3. Logout
  if (path === "/dashboard/logout" && method === "POST") {
    pushAudit({ action: "logout" });
    return new Response(null, {
      status: 302,
      headers: { "Location": "/dashboard", "Set-Cookie": clearCookie() },
    });
  }

  // 3b. Public PWA assets under /dashboard/ask/.
  //     The browser fetches these before the user is logged in (the
  //     service worker is registered on the login page, and the manifest
  //     is consulted by the browser when "Add to Home Screen" is offered).
  //     Keep them public so the login page itself can install the PWA.
  if (path === "/dashboard/ask/manifest.json") {
    return new Response(readFileSync(join(DASHBOARD_DIR, "ask/manifest.json"), "utf-8"), {
      status: 200, headers: { "content-type": "application/manifest+json" },
    });
  }
  if (path === "/dashboard/ask/sw.js") {
    return new Response(readFileSync(join(DASHBOARD_DIR, "ask/sw.js"), "utf-8"), {
      status: 200, headers: { "content-type": "application/javascript" },
    });
  }

  // 3c. /dashboard/ask/ — gated by the same cookie as the rest of /dashboard.
  //     No cookie → redirect to /dashboard (which serves the login page).
  if (path === "/dashboard/ask/" || path === "/dashboard/ask") {
    if (!checkCookie(req)) {
      return new Response(null, { status: 302, headers: { "Location": "/dashboard" } });
    }
    return new Response(loadHtml("ask/index.html"), {
      status: 200, headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 4. From here on, everything requires the cookie
  if (!checkCookie(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // 5. API routes
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
    let payload: any;
    try { payload = JSON.parse(txt); } catch { payload = { error: "bad upstream", raw: txt.slice(0, 200) }; }
    if (Array.isArray(payload?.results)) {
      const nodes = payload.results.map((r: any) => ({
        model: String(r.name ?? ""),
        raw: String(r.name ?? ""),
        tickets: Number(r.count ?? 0),
      }));
      return new Response(JSON.stringify({ nodes, total_groups: nodes.length, period: payload.period }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(txt, { status: r.status, headers: { "content-type": "application/json" } });
  }
  if (path === "/dashboard/api/audit" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") || "20");
    return new Response(JSON.stringify({ entries: auditLog.slice(-limit).reverse() }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (path === "/dashboard/api/diff" && method === "GET") {
    // Stub: return the recent audit log entries that are mutations.
    // A future version can compute a real diff against an mtime.
    const since = url.searchParams.get("since") || new Date(Date.now() - 3600e3).toISOString();
    const sinceMs = Date.parse(since) || 0;
    const changes = auditLog
      .filter(e => ["approval", "answer"].includes(e.action) && Date.parse(e.t) >= sinceMs)
      .map(e => ({
        entity: e.tool || "answer",
        id: e.t,
        action: e.action,
        t: e.t,
        before: null,
        after: e.detail,
      }));
    return new Response(JSON.stringify({ changes }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path === "/dashboard/api/revert" && method === "POST") {
    const body = await req.json().catch(() => ({} as any));
    // Revert is not generically implementable yet — record the request so
    // the operator can re-run it manually. The /v1/jobs/:sorszam endpoint
    // already supports modify_ticket for ticket reverts.
    pushAudit({ action: "revert_request", tool: String(body.entity || ""), detail: String(body.id || "") });
    return new Response(JSON.stringify({ ok: true, note: "recorded; manual revert via /v1/jobs/:sorszam" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (path === "/dashboard/api/tokens" && method === "GET") {
    return new Response(JSON.stringify({
      read_token_prefix: READ_TOKEN ? READ_TOKEN.slice(0, 8) + "..." : "(unset)",
      write_token_prefix: WRITE_TOKEN ? WRITE_TOKEN.slice(0, 8) + "..." : "(unset, falls back to read)",
      bearer_token_prefix: process.env.MCP_BEARER_TOKEN ? process.env.MCP_BEARER_TOKEN.slice(0, 8) + "..." : "(unset)",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path === "/dashboard/api/tokens/rotate" && method === "POST") {
    // Server-side token rotation is not wired yet. Show the operator
    // where to change the token and audit the request.
    pushAudit({ action: "token_rotate_request" });
    return new Response(JSON.stringify({
      ok: false,
      note: "rotate via deploy script: update CMMS_API_TOKEN_READ in /etc/cmms-api.env then re-run deploy-binary.ts and deploy-mcp.ts",
    }), { status: 501, headers: { "content-type": "application/json" } });
  }
  if (path.startsWith("/dashboard/api/approvals/") && method === "POST") {
    const id = path.split("/").pop() || "";
    const body = await req.json().catch(() => ({} as any));
    const ok = resolveApproval(id, !!body.approved);
    return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 404, headers: { "content-type": "application/json" } });
  }

  // 6. SSE stream
  //
  // Server-Sent Events over Bun. The trick is to use a TransformStream
  // (which gives a WritableStream on the downstream side that we can
  // enqueue to from outside the start callback) instead of a
  // ReadableStream (whose controller is finicky in Bun.serve after the
  // handler returns). Each subscriber gets its own TransformStream and
  // is added to the global subscriber set; emitStreamEvent() pushes to
  // every live stream.
  if (path === "/dashboard/api/stream" && method === "GET") {
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transform.writable.getWriter();
    const encoder = new TextEncoder();
    const close = () => {
      streamSubscribers.delete(send);
      try { writer.close(); } catch { /* already closed */ }
    };
    const send = async (ev: StreamEvent) => {
      try {
        await writer.write(encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      } catch { close(); }
    };
    streamSubscribers.add(send);
    // initial hello
    writer.write(encoder.encode(`event: hello\ndata: ${JSON.stringify({ t: new Date().toISOString() })}\n\n`)).catch(close);
    // keepalive every 15s
    const ka = setInterval(() => {
      writer.write(encoder.encode(": keepalive\n\n")).catch(() => { clearInterval(ka); close(); });
    }, 15_000);
    // cleanup when the client disconnects
    req.signal.addEventListener("abort", () => { clearInterval(ka); close(); });
    return new Response(transform.readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  return new Response("not found", { status: 404 });
}

function tryExtractQ(body: string): string {
  try { return String((JSON.parse(body).q || "")).slice(0, 200); } catch { return ""; }
}
function tryExtractSummary(txt: string): string {
  try {
    const o = JSON.parse(txt);
    return String(o.summary || o.intent || o.results?.length || "").slice(0, 200);
  } catch { return ""; }
}
