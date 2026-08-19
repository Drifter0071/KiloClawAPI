// Tests for the async agent job endpoints (no-time-limit dashboard path):
//   POST /v1/answer-agent/async  → 202 { job_id } (background run)
//   GET  /v1/answer-agent/async/:jobId → running | done | error
//
// Background (2026-08-19): the zrok edge cuts proxied responses at ~60s.
// Complex questions (machine history across years) need 1-3 minutes of
// evidence gathering, so the dashboard path runs the agent as a job with
// the soft deadline DISABLED (softDeadlineMs: 0) and a 5-minute hard
// timeout. The sync POST /v1/answer-agent keeps its soft-deadline default
// for direct API clients. These tests prove both behaviors.

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";

// ---------------------------------------------------------------------------
// Fetch stub (same pattern as 29-agent.test.ts): scripted /chat/completions
// + canned self-fetch; everything else passes through to the harness.
// ---------------------------------------------------------------------------

const origFetch = globalThis.fetch;

type ChatStep = {
  body?: unknown;
  status?: number;
  /** Simulate a slow LLM round (used to prove the soft deadline stays OFF). */
  delayMs?: number;
};

let chatScript: ChatStep[] = [];
let chatCalls: Array<{ url: string; options: RequestInit }> = [];
let cannedSelf: Record<string, unknown> = {};

function installStub(): void {
  chatCalls = [];
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (url.includes("/chat/completions")) {
      chatCalls.push({ url, options: init ?? {} });
      const step = chatScript.shift() ?? {};
      const payload = step.body ?? { choices: [{ message: { content: "stub-ok" } }] };
      const make = () =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: step.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        );
      if (step.delayMs) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            make().then(resolve);
          }, step.delayMs);
        });
      }
      return make();
    }
    const u = new URL(url);
    if (cannedSelf[u.pathname] !== undefined) {
      return Promise.resolve(
        new Response(JSON.stringify(cannedSelf[u.pathname]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;
}

function toolCallMsg(name: string, args: unknown, id = "call-1") {
  return {
    content: null,
    tool_calls: [
      { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Harness server
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
];

let server: TestServer;
let fx: Fixture;

beforeAll(async () => {
  fx = buildFixture(rows);
  server = await startTestServer(fx);
});

afterAll(() => {
  globalThis.fetch = origFetch;
  server.stop();
  cleanupFixture(fx);
});

beforeEach(() => {
  // Deterministic baseline (shared process env — see 29-agent header).
  delete process.env.KILO_API_KEY;
  delete process.env.CMMS_API_URL;
  process.env.CMMS_API_TOKEN_READ = server.readToken;
  process.env.CMMS_API_TOKEN_WRITE = server.writeToken;
  chatScript = [];
  cannedSelf = {};
});

async function startAsync(q: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${server.url}/v1/answer-agent/async`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${server.readToken}` },
    body: JSON.stringify({ q, ...extra }),
  });
  return { status: r.status, body: (await r.json()) as any };
}

async function pollJob(jobId: string, maxAttempts = 50) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const r = await fetch(`${server.url}/v1/answer-agent/async/${jobId}`, {
      headers: { Authorization: `Bearer ${server.readToken}` },
    });
    const body = (await r.json()) as any;
    if (body.status === "done" || body.status === "error" || r.status === 404) return { status: r.status, body };
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("pollJob: job never settled");
}

describe("POST /v1/answer-agent/async", () => {
  test("missing/blank q → 400 missing_q (job not created)", async () => {
    const { status, body } = await startAsync("   ");
    expect(status).toBe(400);
    expect(body.error.code).toBe("missing_q");
  });

  test("no Kilo key → 503 agent_unconfigured", async () => {
    const { status, body } = await startAsync("M26057 vezérlés");
    expect(status).toBe(503);
    expect(body.error.code).toBe("agent_unconfigured");
  });

  test("202 + job_id immediately; poll shows running → done with full result", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    cannedSelf["/v1/answer"] = { filters: {}, summary: "x" };
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("answer_question", { q: "M26057 vezérlés" }, "call-1") }] }, delayMs: 60 },
      { body: { choices: [{ message: { content: "Async kész válasz." } }] } },
    ];
    installStub();
    const { status, body } = await startAsync("M26057 vezérlés");
    expect(status).toBe(202);
    expect(typeof body.job_id).toBe("string");
    expect(body.job_id.length).toBeGreaterThan(0);
    expect(body.status).toBe("running");

    const poll = await pollJob(body.job_id);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe("done");
    expect(poll.body.result.final_text).toBe("Async kész válasz.");
    expect(poll.body.result.answer_id).toBeTruthy();
    expect(poll.body.result.iterations).toBe(2);
    expect(poll.body.result.tool_trace).toHaveLength(1);
    expect(poll.body.result.tool_trace[0]).toMatchObject({ name: "answer_question", ok: true });
    expect(poll.body.result.soft_deadline_forced).toBe(false);
  });

  test("async job never forces the soft deadline (no time limit) — tools stay on later rounds", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    // Hostile env: if the async path ever lost its softDeadlineMs: 0
    // override (it did — an argument-order bug silently dropped the
    // options), this 30ms env default would force a truncated answer.
    process.env.AGENT_SOFT_DEADLINE_MS = "30";
    cannedSelf["/v1/answer"] = { filters: {}, summary: "x" };
    // Round 1 is slow (60ms) — on the SYNC path with a tiny soft deadline
    // this would trigger the forced synthesis. The async path must NOT:
    // round 2 keeps the full tool list + tool_choice auto.
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("answer_question", { q: "x" }, "call-1") }] }, delayMs: 60 },
      { body: { choices: [{ message: { content: "Teljes, nem kényszerített válasz." } }] } },
    ];
    installStub();
    const { status, body } = await startAsync("x");
    expect(status).toBe(202);
    const poll = await pollJob(body.job_id);
    expect(poll.body.status).toBe("done");
    expect(poll.body.result.soft_deadline_forced).toBe(false);
    // The second (final) round shipped WITH tools and tool_choice auto —
    // no forced-synthesis round happened.
    expect(chatCalls.length).toBe(2);
    const finalRound = JSON.parse(String(chatCalls[1]!.options.body));
    expect(finalRound.tools).toBeDefined();
    expect(finalRound.tool_choice).toBe("auto");
    const msgs = finalRound.messages as Array<{ role: string; content: string }>;
    expect(msgs.some((m) => m.role === "system" && m.content.includes("TIME LIMIT"))).toBe(false);
    delete process.env.AGENT_SOFT_DEADLINE_MS;
  });

  test("LLM hard failure → job status error with code agent_failed", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    chatScript = [{ status: 500 }];
    installStub();
    const { status, body } = await startAsync("hibás kérdés");
    expect(status).toBe(202);
    const poll = await pollJob(body.job_id);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe("error");
    expect(poll.body.error.code).toBe("agent_failed");
  });

  test("unknown job id → 404 job_not_found", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    installStub();
    const r = await fetch(`${server.url}/v1/answer-agent/async/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${server.readToken}` },
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as any;
    expect(body.error.code).toBe("job_not_found");
  });
});

describe("sync POST /v1/answer-agent still soft-deadline-forces (per-request override)", () => {
  test("softDeadlineMs body override enables forced synthesis on the sync path", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    cannedSelf["/v1/answer"] = { filters: {}, summary: "x" };
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("answer_question", { q: "x" }, "call-1") }] }, delayMs: 60 },
      { body: { choices: [{ message: { content: "Időből készült válasz." } }] } },
    ];
    installStub();
    const r = await fetch(`${server.url}/v1/answer-agent`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${server.readToken}` },
      body: JSON.stringify({ q: "x", language: "hu", softDeadlineMs: 30 }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.soft_deadline_forced).toBe(true);
    // The forced final round shipped WITHOUT tools (model cannot call tools).
    const forced = JSON.parse(String(chatCalls[1]!.options.body));
    expect(forced.tools).toBeUndefined();
  });
});
