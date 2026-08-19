// Dashboard password-gate tests for the v2 SPA layout.
//
// Verifies:
//   - /dashboard is fully disabled (404) when DASHBOARD_PASSWORD is unset.
//   - /dashboard/v2 and /dashboard/v2/login serve the SPA shell to
//     unauthenticated visitors (Vue mounts LoginPage at runtime; the
//     server just hands over index.html).
//   - /dashboard/v2/ask (and other v2 sub-paths) redirect to
//     /dashboard/v2/login when no cookie is present.
//   - /dashboard/v2 redirects to /dashboard/v2/ask when a valid
//     cookie is present.
//   - /dashboard/login (form-encoded) redirects to /dashboard/v2/ask
//     on the right password and to /dashboard/v2/login?error=1 on
//     the wrong one.
//   - /dashboard/login (JSON) returns the bearer token on success,
//     401 on failure.
//   - /dashboard/api/acquire-token requires a valid cookie.
//   - /dashboard/api/* accepts a bearer token in addition to the
//     session cookie (the v2 SPA stores the token in sessionStorage
//     so API calls survive cookie expiry / new tabs / cleared
//     cookies).
//   - /dashboard/logout clears the cookie.
//   - Tampered cookie signatures are rejected.
//   - The SSE stream at /dashboard/api/stream delivers multiple
//     events on the same connection (regression test for the bug
//     where only the first event came through).
//
// Removed in Phase 6: the legacy /dashboard/ask/ mobile-first UI,
// the PWA manifest/sw.js, and the legacy /dashboard/ops/ 4-tab
// dashboard. The v2 SPA owns the ask, stream, map, diff and tokens
// surfaces under /dashboard/v2/.

// Set env vars BEFORE the dashboard/server module loads, because it
// reads CMMS_API_TOKEN_READ at module init time. Bun's import
// hoisting otherwise would load the module before this assignment.
process.env.CMMS_API_TOKEN_READ = process.env.CMMS_API_TOKEN_READ || "test-read-token-for-dashboard";
process.env.CMMS_API_TOKEN_WRITE = process.env.CMMS_API_TOKEN_WRITE || "test-write-token-for-dashboard";
process.env.CMMS_API_URL = process.env.CMMS_API_URL || "http://127.0.0.1:1";

import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleDashboard, emitStreamEvent, withToolStreamLog } from "../dashboard/server";

function mkReq(path: string, init: any = {}) {
  return handleDashboard(new Request("http://test.local" + path, init));
}

// Parse the actual asset URLs out of the built index.html so the tests
// follow the build instead of hardcoding content hashes.
function builtAssetUrls(): { js: string; css: string } {
  const html = readFileSync(join(import.meta.dir, "..", "dashboard", "v2", "index.html"), "utf-8");
  const js = html.match(/src="([^"]+\.js)"/)?.[1] ?? "";
  const css = html.match(/href="([^"]+\.css)"/)?.[1] ?? "";
  if (!js || !css) throw new Error("built index.html missing js/css asset refs");
  return { js, css };
}

describe("dashboard auth gate (v2 SPA)", () => {
  let originalPassword: string | undefined;
  beforeEach(() => {
    originalPassword = process.env.DASHBOARD_PASSWORD;
    // Force a long deterministic read token + a dead cmms-api URL so
    // tests are isolated from whatever other test files (e.g. the
    // harness) may have left in the shared process env. Bun runs all
    // test files in one process, so process.env mutations leak across
    // files.
    process.env.CMMS_API_URL = "http://127.0.0.1:1";
    process.env.CMMS_API_TOKEN_READ = "test-read-token-for-dashboard";
    process.env.CMMS_API_TOKEN_WRITE = "test-write-token-for-dashboard";
  });

  test("dashboard disabled when DASHBOARD_PASSWORD is unset (returns 404)", async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const r = await mkReq("/dashboard");
    expect(r.status).toBe(404);
    const r2 = await mkReq("/dashboard/api/answer", { method: "POST" });
    expect(r2.status).toBe(404);
  });

  test("/dashboard/v2 without cookie redirects to /dashboard/v2/login (was: served the shell)", async () => {
    // Regression for the reported bug: the root used to serve the SPA
    // shell without a cookie, and vue-router (no auth guard) redirected
    // "/" to "/ask" — so unauthenticated visitors saw the Ask page and
    // only reached the login after a refresh. The root must forward to
    // /login. The shell-without-cookie case is now exclusively the
    // /dashboard/v2/login entry (tested below).
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/");
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard/v2/login");
  });

  test("bare /dashboard redirects to /dashboard/v2/ (legacy entry URL)", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    for (const p of ["/dashboard", "/dashboard/"]) {
      const r = await mkReq(p);
      expect(r.status).toBe(302);
      expect(r.headers.get("Location")).toBe("/dashboard/v2/");
    }
    const post = await mkReq("/dashboard", { method: "POST" });
    expect(post.status).toBe(405);
  });

  test("/dashboard/v2/login serves the v2 SPA shell when no cookie", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/login");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain('id="app"');
    expect(html).toContain("/dashboard/v2/assets/");
  });

  test("/dashboard/v2/assets/*.js is served WITHOUT a cookie (LoginPage needs it)", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const { js } = builtAssetUrls();
    const r = await mkReq(js);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/javascript");
    const body = await r.text();
    expect(body.length).toBeGreaterThan(100);
  });

  test("/dashboard/v2/assets/*.css is served with text/css", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const { css } = builtAssetUrls();
    const r = await mkReq(css);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/css");
    expect(r.headers.get("cache-control")).toContain("immutable");
  });

  test("/dashboard/v2/assets path traversal is rejected", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    // %2F stays encoded in the URL parser, so these reach the asset
    // handler and the traversal guard must 404 them.
    for (const p of [
      "/dashboard/v2/assets/..%2Fserver.ts",
      "/dashboard/v2/assets/..%2f..%2f..%2fetc%2fpasswd",
    ]) {
      const r = await mkReq(p);
      expect(r.status).toBe(404);
    }
    // %2e%2e is decoded to ".." BY the URL parser itself, so the path
    // is normalized to /dashboard/v2/server.ts before the handler sees
    // it — that hits the cookie-gated shell rule (302 without cookie).
    // The file content is never served either way.
    const r = await mkReq("/dashboard/v2/assets/%2e%2e/server.ts");
    expect([302, 404]).toContain(r.status);
  });

  test("/dashboard/v2/assets unknown file is 404, not the SPA shell", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/assets/nope-12345.js");
    expect(r.status).toBe(404);
  });

  test("/dashboard/v2/favicon.ico is served WITHOUT a cookie (browser tab favicon)", async () => {
    // The browser requests /favicon.ico implicitly the moment a tab
    // opens — long before the user has a chance to log in. If this
    // hits the cookie gate, the browser shows the broken-image icon.
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/favicon.ico");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^image\/x-icon/);
    const body = new Uint8Array(await r.arrayBuffer());
    // ICO magic: 0x00 0x00 0x01 0x00. (Real bytes — not the SPA shell.)
    expect(body[2]).toBe(0x01);
    expect(body[3]).toBe(0x00);
  });

  test("/dashboard/v2/favicon.png is served WITHOUT a cookie with image/png", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/favicon.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^image\/png/);
  });

  test("/dashboard/v2/apple-touch-icon.png is served WITHOUT a cookie", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/apple-touch-icon.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^image\/png/);
  });

  test("/dashboard/v2/android-chrome-192.png is served WITHOUT a cookie", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/android-chrome-192.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^image\/png/);
  });

  test("/dashboard/v2/brand-mark.png is served WITHOUT a cookie (in-app brand)", async () => {
    // The brand mark is loaded by NctMark.vue inside the SPA — the SPA
    // shell is already authed, but this rule keeps the brand mark
    // loadable even before login so the LoginPage hero can show it.
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/brand-mark.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^image\/png/);
  });

  test("/dashboard/v2 public root files have a cacheable cache-control header", async () => {
    // The browser caches favicon aggressively anyway. A long-lived
    // cache makes reloads snappy; must-revalidate ensures we never
    // stick on a stale icon if we do push a new one.
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/favicon.ico");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toMatch(/public/);
    expect(r.headers.get("cache-control")).toMatch(/must-revalidate/);
  });

  test("/dashboard/v2 unknown public file is 404, not the SPA shell (no path leak)", async () => {
    // Make sure the public-files allowlist doesn't accidentally
    // expose arbitrary files at the v2 root.
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/totally-bogus-file.png");
    // Either: (a) 404 from the cookie-gate rule (because we have no
    // cookie and the path doesn't match the public allowlist), or
    // (b) 302 redirect to /login. Both are safe. What is NOT safe is
    // the server returning the SPA shell HTML or the raw file.
    expect([302, 404]).toContain(r.status);
    const ct = r.headers.get("content-type") ?? "";
    if (r.status === 404) {
      // 404 must NOT be the SPA shell HTML.
      expect(ct).not.toMatch(/^text\/html/);
    }
  });

  test("/dashboard/v2/ask without cookie redirects to /dashboard/v2/login", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/ask");
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard/v2/login");
  });

  test("/dashboard/v2/stream without cookie redirects to /dashboard/v2/login", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/v2/stream");
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard/v2/login");
  });

  test("/dashboard/v2 with valid cookie redirects to /dashboard/v2/ask", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    const r = await mkReq("/dashboard/v2", { headers: { cookie } });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard/v2/ask");
  });

  test("/dashboard/v2 without cookie redirects to /dashboard/v2/login (no Ask flash)", async () => {
    // Regression: the root used to serve the SPA shell without a
    // cookie and vue-router (no auth guard) redirected "/" to "/ask" —
    // so unauthenticated visitors landed on the Ask page and only saw
    // the login after a refresh. The root must forward to /login.
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    for (const p of ["/dashboard/v2", "/dashboard/v2/"]) {
      const r = await mkReq(p);
      expect(r.status).toBe(302);
      expect(r.headers.get("Location")).toBe("/dashboard/v2/login");
    }
  });

  test("/dashboard/v2/ask with valid cookie serves the SPA shell", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    const r = await mkReq("/dashboard/v2/ask", { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain('id="app"');
  });

  test("legacy /dashboard/ask/ is no longer served (404)", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    const r = await mkReq("/dashboard/ask/", { headers: { cookie } });
    expect(r.status).toBe(404);
  });

  test("legacy /dashboard/ops/ is no longer served (404)", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    const r = await mkReq("/dashboard/ops/", { headers: { cookie } });
    expect(r.status).toBe(404);
  });

  test("PWA manifest is no longer served at /dashboard/ask/manifest.json", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/ask/manifest.json");
    // The path no longer matches a served route. It either hits the
    // auth gate (401) or falls through to a 404 — both are correct
    // signals that the PWA asset is gone.
    expect([401, 404]).toContain(r.status);
  });

  test("PWA service worker is no longer served at /dashboard/ask/sw.js", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/ask/sw.js");
    expect([401, 404]).toContain(r.status);
  });

  test("wrong password (form-encoded) redirects to /dashboard/v2/login?error=1", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=wrong",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard/v2/login?error=1");
  });

  test("right password (form-encoded) sets cookie and redirects to /dashboard/v2/ask", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard/v2/ask");
    const cookie = r.headers.get("Set-Cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("cmms_dash_sid=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("right password via JSON body returns the bearer token", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "tarantula999" }),
    });
    // JSON login returns 200 with the bearer token, not 302. The
    // LoginPage POSTs as JSON and stores the token in sessionStorage.
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(typeof j.token).toBe("string");
    expect(j.token.length).toBeGreaterThan(20);
    expect(r.headers.get("Set-Cookie")).toContain("cmms_dash_sid=");
  });

  test("wrong password via JSON body returns 401 with error", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(r.status).toBe(401);
    const j = await r.json() as any;
    expect(j.ok).toBe(false);
  });

  test("acquire-token works with a valid cookie, returns 401 without", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    // Without cookie
    const r1 = await mkReq("/dashboard/api/acquire-token", { method: "POST" });
    expect(r1.status).toBe(401);
    // With cookie
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    const r2 = await mkReq("/dashboard/api/acquire-token", {
      method: "POST",
      headers: { cookie },
    });
    expect(r2.status).toBe(200);
    const j = await r2.json() as any;
    expect(j.ok).toBe(true);
    expect(typeof j.token).toBe("string");
  });

  test("dashboard API accepts bearer token (not just cookie)", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    // Get a token via JSON login
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "tarantula999" }),
    });
    const j = await lr.json() as any;
    const token = j.token;
    // Use the bearer token to call the API (no cookie sent)
    const r = await mkReq("/dashboard/api/tokens", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // The test router may not have CMMS_API_URL set; we just need
    // the auth gate to pass. If the proxied cmms-api is unavailable
    // the proxy will 503, but the auth gate passing is verified by
    // NOT getting a 401.
    expect(r.status).not.toBe(401);
  });

  test("api endpoints return 401 without cookie or bearer", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    for (const path of ["/dashboard/api/answer", "/dashboard/api/map", "/dashboard/api/audit", "/dashboard/api/diff", "/dashboard/api/tokens"]) {
      const r = await mkReq(path, { method: path === "/dashboard/api/answer" || path === "/dashboard/api/revert" || path === "/dashboard/api/tokens/rotate" || path.startsWith("/dashboard/api/approvals") ? "POST" : "GET" });
      expect(r.status).toBe(401);
      const j = await r.json();
      expect(j.error).toBe("unauthorized");
    }
  });

  // Operator feedback routes (vote / my-votes / correction) are read-
  // gated on cmms-api and require a user cookie OR bearer on the proxy.
  // With valid auth + dead upstream URL, the proxy fetch throws and the
  // route catches it to return 503 — proving the proxy is wired and
  // not falling through to a default 404.
  test("operator feedback proxy routes are wired (not 404)", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    // 1) Without any auth → 401
    const u1 = await mkReq("/dashboard/api/feedback/vote", { method: "POST", body: "{}" });
    expect(u1.status).toBe(401);
    const u2 = await mkReq("/dashboard/api/feedback/my-votes?answer_ids=a");
    expect(u2.status).toBe(401);
    const u3 = await mkReq("/dashboard/api/feedback/correction", { method: "POST", body: "{}" });
    expect(u3.status).toBe(401);
    const u4 = await mkReq("/dashboard/api/feedback/my-corrections?answer_ids=a");
    expect(u4.status).toBe(401);

    // 2) With a valid cookie → 503 (proxy fetch failed) — proves the
    //    proxy is wired and reached upstream, not falling through to
    //    a default 404.
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    expect(lr.status).toBe(302);
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    const headers = { cookie, "X-Cmms-Uid": "11111111-2222-4333-8444-555555555555" };
    const v = await mkReq("/dashboard/api/feedback/vote", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ answer_id: "x", vote: 1 }),
    });
    expect(v.status).toBe(503);
    const vj = await v.json();
    expect(vj.error).toBe("cmms-api unavailable");
    const m = await mkReq("/dashboard/api/feedback/my-votes?answer_ids=x", { headers });
    expect(m.status).toBe(503);
    const mj = await m.json();
    expect(mj.error).toBe("cmms-api unavailable");
    const c = await mkReq("/dashboard/api/feedback/correction", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ answer_id: "x", correction: "y" }),
    });
    expect(c.status).toBe(503);
    const cj = await c.json();
    expect(cj.error).toBe("cmms-api unavailable");
    const cm = await mkReq("/dashboard/api/feedback/my-corrections?answer_ids=x", { headers });
    expect(cm.status).toBe(503);
    const cmj = await cm.json();
    expect(cmj.error).toBe("cmms-api unavailable");

    // 3) With a valid bearer token (no cookie) → 503. The SPA stores
    //    the read token in sessionStorage and re-attaches it to every
    //    fetch, so the routes must accept bearer-only auth.
    const bearerHeaders = {
      "Authorization": "Bearer test-read-token-for-dashboard",
      "X-Cmms-Uid": "11111111-2222-4333-8444-555555555555",
    };
    const v2 = await mkReq("/dashboard/api/feedback/vote", {
      method: "POST",
      headers: { ...bearerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ answer_id: "x", vote: 1 }),
    });
    expect(v2.status).toBe(503);
    const m2 = await mkReq("/dashboard/api/feedback/my-votes?answer_ids=x", { headers: bearerHeaders });
    expect(m2.status).toBe(503);
    const c2 = await mkReq("/dashboard/api/feedback/correction", {
      method: "POST",
      headers: { ...bearerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ answer_id: "x", correction: "y" }),
    });
    expect(c2.status).toBe(503);
    const cm2 = await mkReq("/dashboard/api/feedback/my-corrections?answer_ids=x", { headers: bearerHeaders });
    expect(cm2.status).toBe(503);
  });

  test("logout clears the cookie and redirects to /dashboard/v2/login", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    // Now hit logout
    const lo = await mkReq("/dashboard/logout", { method: "POST", headers: { cookie } });
    expect(lo.status).toBe(302);
    expect(lo.headers.get("Location")).toBe("/dashboard/v2/login");
    const clr = lo.headers.get("Set-Cookie");
    expect(clr).toContain("Max-Age=0");
  });

  test("tampered cookie signature is rejected (302 to /dashboard/v2/login)", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    // A cookie with valid format but bogus signature must NOT let us in.
    const badCookie = "cmms_dash_sid=deadbeef.0000000000000000000000000000000000000000000000000000000000000000";
    const r = await mkReq("/dashboard/v2/ask", { headers: { cookie: badCookie } });
    // Should redirect back to login
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard/v2/login");
  });
});

describe("dashboard SSE stream", () => {
  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
  });

  test("multiple emitStreamEvent calls produce multiple events on the same stream", async () => {
    // Login first to get a cookie (the SSE route is cookie-gated).
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    // Open the SSE connection. We don't use AbortController / cancel
    // because Bun's test runner hangs on the cleanup of an open SSE
    // stream — the keepalive interval would otherwise keep the
    // response alive past test completion. Real clients always
    // disconnect, and the abort handler is in place for that case.
    const r = await handleDashboard(new Request("http://test.local/dashboard/api/stream", {
      headers: { cookie },
    }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    // 1) read the hello — server sends a synthesized answer event
    //    whose summary is "hello" as the connection-ready signal.
    const first = await reader.read();
    expect(first.done).toBe(false);
    const helloChunk = decoder.decode(first.value!);
    expect(helloChunk).toContain("event: answer");
    expect(helloChunk).toContain('"summary":"hello"');
    // 2) emit a question, expect to see it
    emitStreamEvent({ type: "question", t: "2026-08-12T10:00:00Z", tool: "answer", q: "M26057" });
    const second = await reader.read();
    expect(second.done).toBe(false);
    const qChunk = decoder.decode(second.value!);
    expect(qChunk).toContain("event: question");
    expect(qChunk).toContain("M26057");
    // 3) emit an answer, expect to see it too (the original bug was that
    //    only the first event came through; this is the regression test)
    emitStreamEvent({ type: "answer", t: "2026-08-12T10:00:01Z", tool: "answer", summary: "1 talalat" });
    const third = await reader.read();
    expect(third.done).toBe(false);
    const aChunk = decoder.decode(third.value!);
    expect(aChunk).toContain("event: answer");
    expect(aChunk).toContain("1 talalat");
  });

  test("withToolStreamLog emits question+answer for any MCP tool (and HIBA on throw)", async () => {
    // Every MCP tool call must show up on the Live Stream page — not
    // just dashboard asks. The wrapper lives in dashboard/server.ts so
    // it is unit-testable without spawning mcp-server.ts.
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    const r = await handleDashboard(new Request("http://test.local/dashboard/api/stream", {
      headers: { cookie },
    }));
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value!)).toContain('"summary":"hello"');

    // Success path: wrapped handler emits question then answer.
    const wrapped = withToolStreamLog(
      "search_tickets",
      async (args) => ({ total: 1, results: [{ sorszam: "B26071801" }] }),
    );
    const out = await wrapped({ q: "M26057" }, {});
    expect(out).toEqual({ total: 1, results: [{ sorszam: "B26071801" }] });
    const qChunk = decoder.decode((await reader.read()).value!);
    expect(qChunk).toContain("event: question");
    expect(qChunk).toContain("search_tickets");
    expect(qChunk).toContain("M26057");
    const aChunk = decoder.decode((await reader.read()).value!);
    expect(aChunk).toContain("event: answer");
    expect(aChunk).toContain("1 találat");

    // Error path: HIBA event is emitted AND the error still propagates
    // so the MCP client sees the real failure. The wrapper emits the
    // `question` event BEFORE calling the handler, so consume that
    // chunk first, then the HIBA answer.
    const bad = withToolStreamLog("search_tickets", async () => {
      throw new Error("boom");
    });
    await expect(bad({}, {})).rejects.toThrow("boom");
    const badQChunk = decoder.decode((await reader.read()).value!);
    expect(badQChunk).toContain("event: question");
    const errChunk = decoder.decode((await reader.read()).value!);
    expect(errChunk).toContain("event: answer");
    expect(errChunk).toContain("HIBA: boom");
  });
});
