// Tests for the render-only LLM layer (src/lib/llm.ts) and its wiring
// into /v1/answer (summary_llm).
//
// The LLM NEVER picks tools or builds facts — it only rewrites the
// deterministic summary. Every failure path must return null / omit
// summary_llm so the deterministic answer always survives.

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  llmConfigured,
  llmModel,
  llmBaseUrl,
  renderLlmAnswer,
  LLM_DEFAULT_MODEL,
  LLM_DEFAULT_BASE_URL,
} from "../src/lib/llm";
import { startTestServer, type TestServer } from "./harness";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";

// ---------------------------------------------------------------------------
// Global fetch stub with pass-through: only /chat/completions is
// captured; every other request (including the test's own POST to
// /v1/answer) falls through to the real fetch so the harness server
// keeps working.
// ---------------------------------------------------------------------------

const origFetch = globalThis.fetch;
let llmCalls: Array<{ url: string; options: RequestInit }> = [];
let stubBody: unknown = null;
let stubStatus = 200;

function installStub(): void {
  llmCalls = [];
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    if (url.includes("/chat/completions")) {
      llmCalls.push({ url, options: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify(stubBody ?? { choices: [{ message: { content: "stub-render" } }] }), {
          status: stubStatus,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;
}

function installNeverResolvingStub(): { aborted: () => boolean } {
  llmCalls = [];
  let aborted = false;
  globalThis.fetch = ((_input: any, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    })) as typeof fetch;
  return { aborted: () => aborted };
}

beforeEach(() => {
  // Bun's test runner shares ONE process env across all test files —
  // force a deterministic baseline before every test.
  delete process.env.KILO_API_KEY;
  delete process.env.KILO_MODEL;
  delete process.env.KILO_BASE_URL;
  stubBody = null;
  stubStatus = 200;
});

afterAll(() => {
  delete process.env.KILO_API_KEY;
  delete process.env.KILO_MODEL;
  delete process.env.KILO_BASE_URL;
  globalThis.fetch = origFetch;
});

// ---------------------------------------------------------------------------
// Unit: configuration
// ---------------------------------------------------------------------------

describe("llm config", () => {
  test("llmConfigured() false without key, true with key", () => {
    expect(llmConfigured()).toBe(false);
    process.env.KILO_API_KEY = "  ";
    expect(llmConfigured()).toBe(false);
    process.env.KILO_API_KEY = "kilo-abc";
    expect(llmConfigured()).toBe(true);
  });

  test("llmModel() defaults and overrides", () => {
    expect(llmModel()).toBe(LLM_DEFAULT_MODEL);
    process.env.KILO_MODEL = "kilocode/openai/gpt-4o-mini";
    expect(llmModel()).toBe("kilocode/openai/gpt-4o-mini");
  });

  test("llmBaseUrl() defaults and overrides (trailing slash stripped)", () => {
    expect(llmBaseUrl()).toBe(LLM_DEFAULT_BASE_URL);
    process.env.KILO_BASE_URL = "https://example.com/proxy/";
    expect(llmBaseUrl()).toBe("https://example.com/proxy/");
  });
});

// ---------------------------------------------------------------------------
// Unit: renderLlmAnswer behavior
// ---------------------------------------------------------------------------

describe("renderLlmAnswer", () => {
  const args = {
    question: "M26057 vezérlés",
    language: "hu" as const,
    summary: "Az M26057 vezérlése: NCTNCT 4. (forrás: B26071801, PLASMA-TECH SYSTEMS KFT., 2026-07-18)",
    mode: "answer" as const,
    candidates: [{ intent: "device_top_problem", score: 0.4, summary: "Az M26057 leggyakoribb hibái: X" }],
    periodLabel: "minden időszakban",
  };

  test("unconfigured -> null, fetch never called", async () => {
    installStub();
    const out = await renderLlmAnswer(args);
    expect(out).toBeNull();
    expect(llmCalls.length).toBe(0);
  });

  test("200 with content -> returns content + correct request shape", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    stubBody = { choices: [{ message: { content: "  Átírt válasz.  " } }] };
    installStub();
    const out = await renderLlmAnswer(args);
    expect(out).toBe("Átírt válasz.");
    expect(llmCalls.length).toBe(1);
    const { url, options } = llmCalls[0]!;
    expect(url).toBe(`${LLM_DEFAULT_BASE_URL}/chat/completions`);
    expect((options.headers as Record<string, string>).authorization).toBe("Bearer kilo-test-key");
    const body = JSON.parse(options.body as string) as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(LLM_DEFAULT_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(500);
    expect(body.messages[0]!.role).toBe("system");
    const user = body.messages[1]!.content;
    expect(user).toContain("M26057 vezérlés");
    expect(user).toContain("Az M26057 vezérlése: NCTNCT 4.");
    expect(user).toContain("device_top_problem");
    expect(user).toContain("minden időszakban");
  });

  test("non-2xx -> null", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    stubStatus = 500;
    installStub();
    const out = await renderLlmAnswer(args);
    expect(out).toBeNull();
    expect(llmCalls.length).toBe(1);
  });

  test("empty/blank content -> null", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    stubBody = { choices: [{ message: { content: "   " } }] };
    installStub();
    const out = await renderLlmAnswer(args);
    expect(out).toBeNull();
  });

  test("missing choices -> null", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    stubBody = { foo: "bar" };
    installStub();
    const out = await renderLlmAnswer(args);
    expect(out).toBeNull();
  });

  test("network error -> null", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    globalThis.fetch = (() => Promise.reject(new Error("ECONNRESET"))) as typeof fetch;
    const out = await renderLlmAnswer(args);
    expect(out).toBeNull();
  });

  test("timeout aborts the request and returns null", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    const spy = installNeverResolvingStub();
    const out = await renderLlmAnswer(args, 40);
    expect(out).toBeNull();
    expect(spy.aborted()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route: /v1/answer summary_llm wiring
// ---------------------------------------------------------------------------

const rows: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B26071801",
    "1": "2026.07.18",
    "AKTUÁLIS NÉV": "PLASMA-TECH SYSTEMS KFT.",
    "KÉSZÜLÉK TIPUSA": "NCT99;M-26057;SW-2.0;",
    "BEJELENTETT HIBA": "Vezérlő: NCT iHDW-A2 firmware v3.41",
    "ELVÉGZETT MUNKA": "tápegység csere",
    "NY/Z": 1,
  },
  {
    KEY: 2,
    "BEJELENTÉS SORSZÁMA": "B26081234",
    "1": "2026.08.12",
    "AKTUÁLIS NÉV": "METARAD KFT.",
    "KÉSZÜLÉK TIPUSA": "NCTNCT 4(17 20x xxx);M-55555;",
    "BEJELENTETT HIBA": "nem indul",
    "ELVÉGZETT MUNKA": "javítás",
    "NY/Z": 0,
  },
];

let server: TestServer;
let fx: Fixture;

beforeAll(async () => {
  fx = buildFixture(rows);
  server = await startTestServer(fx);
});

afterAll(async () => {
  server.stop();
  cleanupFixture(fx);
});

async function ask(q: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${server.url}/v1/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${server.readToken}` },
    body: JSON.stringify({ q, ...extra }),
  });
  return { status: r.status, body: (await r.json()) as any };
}

describe("/v1/answer summary_llm", () => {
  test("llm:true without key -> no summary_llm, summary unchanged, no LLM call", async () => {
    installStub();
    const { status, body } = await ask("M26057 vezérlés", { llm: true });
    expect(status).toBe(200);
    expect(typeof body.summary).toBe("string");
    expect(body.summary.length).toBeGreaterThan(0);
    expect(body.summary_llm).toBeNull();
    expect(llmCalls.length).toBe(0);
  });

  test("llm absent -> no summary_llm even with key configured", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    installStub();
    const { body } = await ask("M26057 vezérlés");
    expect(body.summary_llm).toBeNull();
    expect(llmCalls.length).toBe(0);
  });

  test("llm:true with key -> summary_llm present, deterministic summary untouched", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    installStub();
    const base = (await ask("M26057 vezérlés")).body;
    expect(base.summary_llm).toBeNull();
    const { body } = await ask("M26057 vezérlés", { llm: true });
    expect(body.summary_llm).toBe("stub-render");
    expect(body.summary).toBe(base.summary);
    expect(llmCalls.length).toBe(1);
    expect(llmCalls[0]!.url).toContain("/chat/completions");
  });

  test("llm:true with key but failing LLM -> summary_llm null, still 200", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    stubStatus = 502;
    installStub();
    const { status, body } = await ask("M26057 vezérlés", { llm: true });
    expect(status).toBe(200);
    expect(body.summary_llm).toBeNull();
    expect(body.summary.length).toBeGreaterThan(0);
  });
});
