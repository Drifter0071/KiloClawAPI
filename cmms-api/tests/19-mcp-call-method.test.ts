// Phase 5.1 regression: MCP call() helper must not send a body with
// GET/HEAD/OPTIONS. Node fetch() rejects that with
//   "fetch() request with GET/HEAD/OPTIONS method cannot have body"
// which was happening every time the LLM called any of the 5
// integration search tools (search_serviz_belso, search_szev_igeny,
// search_telephely_munka, search_ais_motor_inventory, get_serviz_ticket)
// with a `q` argument.

import { describe, test, expect } from "bun:test";

// Replicate the body-encoding decision from mcp-server.ts:line ~54-100.
// We don't export the helper, so we test the same logic the helper uses.
function buildUrlAndBody(path: string, method: string, body: unknown): { url: string; body: string | undefined; useBody: boolean } {
  const m = (method ?? "GET").toUpperCase();
  const useBody = m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
  if (useBody) {
    return { url: path, body: body ? JSON.stringify(body) : undefined, useBody: true };
  }
  let qs = "";
  if (body && typeof body === "object") {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item === undefined || item === null) continue;
          params.append(k, typeof item === "string" ? item : JSON.stringify(item));
        }
      } else if (typeof v === "object") {
        params.append(k, JSON.stringify(v));
      } else {
        params.append(k, String(v));
      }
    }
    const s = params.toString();
    if (s) qs = (path.includes("?") ? "&" : "?") + s;
  }
  return { url: path + qs, body: undefined, useBody: false };
}

describe("MCP call() body encoding", () => {
  test("GET + body -> encoded as query string, no body", () => {
    const out = buildUrlAndBody("/v1/integration/serviz/search", "GET", { q: "M09192", limit: 5 });
    expect(out.useBody).toBe(false);
    expect(out.body).toBeUndefined();
    expect(out.url).toContain("q=M09192");
    expect(out.url).toContain("limit=5");
  });
  test("HEAD + body -> encoded as query string, no body", () => {
    const out = buildUrlAndBody("/v1/integration/stats", "HEAD", { foo: "bar" });
    expect(out.useBody).toBe(false);
    expect(out.body).toBeUndefined();
    expect(out.url).toContain("foo=bar");
  });
  test("OPTIONS + body -> encoded as query string, no body", () => {
    const out = buildUrlAndBody("/v1/anything", "OPTIONS", { a: "1" });
    expect(out.useBody).toBe(false);
    expect(out.body).toBeUndefined();
    expect(out.url).toContain("a=1");
  });
  test("POST + body -> sent as JSON body, no query string", () => {
    const out = buildUrlAndBody("/v1/answer", "POST", { q: "M09192" });
    expect(out.useBody).toBe(true);
    expect(out.body).toBe('{"q":"M09192"}');
    expect(out.url).toBe("/v1/answer");
  });
  test("GET with empty/null/undefined values -> dropped from query string", () => {
    const out = buildUrlAndBody("/v1/integration/serviz/search", "GET", { q: "M09192", j: "", year: null, date_from: undefined, limit: 10 });
    expect(out.useBody).toBe(false);
    expect(out.url).toContain("q=M09192");
    expect(out.url).toContain("limit=10");
    expect(out.url).not.toContain("j=");
    expect(out.url).not.toContain("year=");
    expect(out.url).not.toContain("date_from=");
  });
  test("GET with array values -> repeated keys", () => {
    const out = buildUrlAndBody("/v1/integration/serviz/search", "GET", { status: ["open", "closed"] });
    expect(out.useBody).toBe(false);
    expect(out.url).toContain("status=open");
    expect(out.url).toContain("status=closed");
  });
  test("GET preserves existing ?query in path", () => {
    const out = buildUrlAndBody("/v1/integration/serviz/search?source=cmms", "GET", { q: "M09192" });
    expect(out.url).toMatch(/^\/v1\/integration\/serviz\/search\?/);
    expect(out.url).toContain("source=cmms");
    expect(out.url).toContain("q=M09192");
  });
});
