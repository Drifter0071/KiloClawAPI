// Dashboard password-gate tests. Verifies the /dashboard routes require
// a valid session cookie, the login flow works with the right password,
// and the dashboard is fully disabled (404) when DASHBOARD_PASSWORD is
// not set.

import { describe, expect, test, beforeEach } from "bun:test";
import { handleDashboard } from "../dashboard/server";

function mkReq(path: string, init: any = {}) {
  return handleDashboard(new Request("http://test.local" + path, init));
}

describe("dashboard auth gate", () => {
  let originalPassword: string | undefined;
  beforeEach(() => {
    originalPassword = process.env.DASHBOARD_PASSWORD;
    // Make sure cmms-api URL doesn't try to actually connect during
    // tests that don't exercise the proxy.
    process.env.CMMS_API_URL = process.env.CMMS_API_URL ?? "http://127.0.0.1:1";
    process.env.CMMS_API_TOKEN_READ = process.env.CMMS_API_TOKEN_READ ?? "test-token";
  });

  test("dashboard disabled when DASHBOARD_PASSWORD is unset (returns 404)", async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const r = await mkReq("/dashboard");
    expect(r.status).toBe(404);
    const r2 = await mkReq("/dashboard/api/answer", { method: "POST" });
    expect(r2.status).toBe(404);
  });

  test("login page served when no cookie", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain('type="password"');
    expect(html).toContain("Enter the access password");
  });

  test("wrong password redirects to login with error=1", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=wrong",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard?error=1");
  });

  test("right password sets cookie and redirects to /dashboard", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard");
    const cookie = r.headers.get("Set-Cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("cmms_dash_sid=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("right password via JSON body also works", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const r = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "tarantula999" }),
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("Set-Cookie")).toContain("cmms_dash_sid=");
  });

  test("dashboard.html served with valid cookie", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    const lr = await mkReq("/dashboard/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=tarantula999",
    });
    const cookie = lr.headers.get("Set-Cookie")!.split(";")[0];
    const r = await mkReq("/dashboard", { headers: { cookie } });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Live Stream");
    expect(html).toContain("Spatial Map");
    expect(html).toContain("Diff / Revert");
    expect(html).toContain("Token Portal");
  });

  test("api endpoints return 401 without cookie", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    for (const path of ["/dashboard/api/answer", "/dashboard/api/map", "/dashboard/api/audit", "/dashboard/api/diff", "/dashboard/api/tokens"]) {
      const r = await mkReq(path, { method: path === "/dashboard/api/answer" || path === "/dashboard/api/revert" || path === "/dashboard/api/tokens/rotate" || path.startsWith("/dashboard/api/approvals") ? "POST" : "GET" });
      expect(r.status).toBe(401);
      const j = await r.json();
      expect(j.error).toBe("unauthorized");
    }
  });

  test("logout clears the cookie", async () => {
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
    const clr = lo.headers.get("Set-Cookie");
    expect(clr).toContain("Max-Age=0");
  });

  test("tampered cookie signature is rejected", async () => {
    process.env.DASHBOARD_PASSWORD = "tarantula999";
    // A cookie with valid format but bogus signature must NOT let us in.
    const badCookie = "cmms_dash_sid=deadbeef.0000000000000000000000000000000000000000000000000000000000000000";
    const r = await mkReq("/dashboard", { headers: { cookie: badCookie } });
    // Should redirect back to login (200 with login page)
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Enter the access password");
  });
});
