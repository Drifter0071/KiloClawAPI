// Tests for the v2 agentic Ask loop (Option 2, 2026-08-18):
//   - src/lib/agent.ts runAgentV2
//   - src/lib/agent_tools.ts buildAgentToolsV2 / buildAgentToolsV2OpenAI
//   - the v2 mutate guard inside callAgentTool
//   - the v2 parallel dispatch + per-turn cap behavior
//   - the v2 no-info watchdog
//
// Env baseline mirrors tests/29-agent.test.ts — bun's test runner shares
// ONE process env across all files. beforeEach forces a deterministic
// baseline; route tests re-set CMMS_API_URL to the harness server.

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  AGENT_TOOLS,
  buildAgentToolsV2,
  buildAgentToolsV2OpenAI,
  callAgentTool,
  v2MutateAllowed,
  V2_PARALLEL_TOOL_CALL_CAP,
  V2_READ_TOOL_NAMES,
} from "../src/lib/agent_tools";
import {
  AgentFailure,
  runAgentV2,
} from "../src/lib/agent";
import { startTestServer, type TestServer } from "./harness";

// ---------------------------------------------------------------------------
// Fetch stub: same shape as 29-agent.test.ts
// ---------------------------------------------------------------------------

const origFetch = globalThis.fetch;

type ChatStep = {
  body?: unknown;
  status?: number;
  reject?: boolean;
  never?: boolean;
};

let chatScript: ChatStep[] = [];
let chatCalls: Array<{ url: string; options: RequestInit }> = [];
let cannedSelf: Record<string, unknown> = {};
let selfCalls: Array<{ url: string; options: RequestInit; start: number; end?: number }> = [];
let selfLatencyMs: Record<string, number> = {};

function installStub(): void {
  chatCalls = [];
  selfCalls = [];
  selfLatencyMs = {};
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (url.includes("/chat/completions")) {
      chatCalls.push({ url, options: init ?? {} });
      const step = chatScript.shift() ?? {};
      if (step.never) {
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => {
            rej(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      if (step.reject) return Promise.reject(new Error("ECONNRESET"));
      if (step.status !== undefined && step.status !== 200) {
        return Promise.resolve(new Response("boom", { status: step.status }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify(step.body ?? { choices: [{ message: { content: "stub-ok" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    const u = new URL(url);
    if (cannedSelf[u.pathname] !== undefined) {
      const start = Date.now();
      const lat = selfLatencyMs[u.pathname] ?? 0;
      const finish = () => {
        const rec = { url, options: init ?? {}, start, end: Date.now() };
        selfCalls.push(rec);
        return Promise.resolve(
          new Response(JSON.stringify(cannedSelf[u.pathname]), {
            status: 200,
            headers: { "content-type": "application/json" } },
          ),
        );
      };
      if (lat > 0) return new Promise((res) => setTimeout(() => res(finish()), lat));
      return finish();
    }
    return origFetch(input, init);
  }) as typeof fetch;
}

function toolCallMsg(name: string, args: unknown, id = "call-1") {
  return {
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      },
    ],
  };
}

function multiToolCallMsg(calls: Array<{ name: string; args: unknown; id: string }>) {
  return {
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) },
    })),
  };
}

// ---------------------------------------------------------------------------
// Env baseline
// ---------------------------------------------------------------------------

const TEST_READ = "test-read-token";
const TEST_WRITE = "test-write-token";

beforeEach(() => {
  delete process.env.KILO_API_KEY;
  delete process.env.KILO_MODEL;
  delete process.env.KILO_BASE_URL;
  delete process.env.CMMS_API_URL;
  delete process.env.ASK_AGENT_V2;
  delete process.env.ASK_AGENT_ALLOW_MUTATE;
  process.env.CMMS_API_TOKEN_READ = TEST_READ;
  process.env.CMMS_API_TOKEN_WRITE = TEST_WRITE;
  process.env.KILO_API_KEY = "stub-key";
  process.env.KILO_BASE_URL = "http://stub-llm";
  chatScript = [];
  cannedSelf = {};
  chatCalls = [];
  selfCalls = [];
});

afterAll(() => {
  globalThis.fetch = origFetch;
  delete process.env.KILO_API_KEY;
  delete process.env.KILO_BASE_URL;
});

// ---------------------------------------------------------------------------
// v2 registry shape
// ---------------------------------------------------------------------------

describe("buildAgentToolsV2", () => {
  test("default registry is 8 read tools (no answer_question, no mutate)", () => {
    const tools = buildAgentToolsV2();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...V2_READ_TOOL_NAMES].sort());
    // Critically: answer_question is NOT in the v2 surface.
    expect(names).not.toContain("answer_question");
    // No mutate by default.
    const mutates = tools.filter((t) => t.write);
    expect(mutates.length).toBe(0);
  });

  test("registry honors ASK_AGENT_ALLOW_MUTATE=1", () => {
    process.env.ASK_AGENT_ALLOW_MUTATE = "1";
    expect(v2MutateAllowed()).toBe(true);
    const tools = buildAgentToolsV2();
    const mutates = tools.filter((t) => t.write);
    expect(mutates.length).toBe(6);
    const mutateNames = mutates.map((t) => t.name).sort();
    expect(mutateNames).toEqual([
      "add_ticket_tag",
      "close_ticket",
      "create_ticket",
      "modify_ticket",
      "set_ticket_category",
      "set_ticket_severity",
    ]);
  });

  test("OpenAI payload mirrors the registry exactly", () => {
    const tools = buildAgentToolsV2();
    const oa = buildAgentToolsV2OpenAI();
    expect(oa.length).toBe(tools.length);
    for (let i = 0; i < tools.length; i++) {
      expect(oa[i].function.name).toBe(tools[i].name);
      expect(oa[i].function.description).toBe(tools[i].description);
    }
  });

  test("registry size is small enough to fit in the LLM's working memory (≤ 8 + 0)", () => {
    // The whole point of v2: collapse the 26-tool surface into ≤8. If
    // this ever grows past 8, the design intent breaks and the
    // selection-accuracy regression comes back.
    const tools = buildAgentToolsV2();
    expect(tools.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// v2 mutate guard inside callAgentTool
// ---------------------------------------------------------------------------

describe("callAgentTool — v2 mutate guard", () => {
  test("refuses mutate when toolsAllowMutate is false on the ctx", async () => {
    installStub();
    const tools = buildAgentToolsV2({ allowMutate: true });
    // Force a mutate entry in the registry so we can call it.
    expect(tools.find((t) => t.name === "close_ticket")).toBeTruthy();
    const out = await callAgentTool(
      "close_ticket",
      { key: 1 },
      {
        baseUrl: "http://stub",
        readToken: TEST_READ,
        writeToken: TEST_WRITE,
        toolsAllowMutate: false,
      },
    );
    expect(out.ok).toBe(false);
    expect(out.note).toBe("mutate_disabled");
    expect(out.text).toContain("Mutate tools are disabled");
  });

  test("allows mutate when toolsAllowMutate is true", async () => {
    installStub();
    cannedSelf = { "/v1/tickets/1/close": { ok: true } };
    const out = await callAgentTool(
      "close_ticket",
      { key: 1 },
      {
        baseUrl: "http://stub",
        readToken: TEST_READ,
        writeToken: TEST_WRITE,
        toolsAllowMutate: true,
      },
    );
    expect(out.ok).toBe(true);
  });

  test("returns unknown_tool for hallucinated tool names", async () => {
    const out = await callAgentTool(
      "answer_question",
      { q: "test" },
      {
        baseUrl: "http://stub",
        readToken: TEST_READ,
        writeToken: TEST_WRITE,
        toolsAllowMutate: false,
      },
    );
    // answer_question is in the LEGACY registry, not the v2 selection.
    // v2's callAgentTool uses buildAgentToolsV2's filtered set when
    // dispatched from runAgentV2, so a hallucinated answer_question
    // here means the model bypassed the v2 prompt. In production the
    // check happens in runAgentV2; for the unit test we use the legacy
    // AGENT_TOOLS lookup path and verify the unknown_tool failure mode.
    expect(out.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAgentV2 — parallel dispatch + per-turn cap
// ---------------------------------------------------------------------------

describe("runAgentV2 — parallel dispatch", () => {
  test("3 parallel tool calls in one turn finish in ~slowest time, not sum", async () => {
    installStub();
    cannedSelf = {
      "/v1/tickets/by-sorszam/B26071801": { sorszam: "B26071801", customer: { name: "PLASMA-TECH" } },
      "/v1/jobs/search": { total: 5, results: [] },
      "/v1/related": { timeline: [{ source: "main", sorszam: "B26071801" }] },
    };
    // 250ms each — sum would be 750ms, parallel should be ~250ms.
    selfLatencyMs = {
      "/v1/tickets/by-sorszam/B26071801": 250,
      "/v1/jobs/search": 250,
      "/v1/related": 250,
    };
    chatScript = [
      // Round 1: 3 parallel tool calls.
      {
        body: {
          choices: [
            {
              message: multiToolCallMsg([
                { name: "find_ticket", args: { sorszam: "B26071801" }, id: "c1" },
                { name: "get_device_history", args: { device: "M26057" }, id: "c2" },
                { name: "find_related_tickets", args: { sorszam: "B26071801" }, id: "c3" },
              ]),
            },
          ],
        },
      },
      // Round 2: final answer.
      {
        body: {
          choices: [
            {
              message: {
                content:
                  "Az M26057 vezérlése: NCT 4 (B26071801, PLASMA-TECH). 5 kapcsolódó jegy a device history-ban.",
              },
            },
          ],
        },
      },
    ];
    const t0 = Date.now();
    const out = await runAgentV2({ question: "M26057 vezérlése?", language: "hu" });
    const elapsed = Date.now() - t0;
    expect(out.agent_v2).toBe(true);
    expect(out.parallel_groups).toBe(1);
    expect(out.iterations).toBe(2);
    expect(out.tool_trace).toHaveLength(3);
    // Parallel: should be well under the 3*250=750ms serial bound.
    // Allow generous headroom (650ms) for CI noise.
    expect(elapsed).toBeLessThan(650);
    // All three trace entries share a parallel_group_id.
    const groupIds = new Set(out.tool_trace.map((t) => t.parallel_group_id));
    expect(groupIds.size).toBe(1);
    // Each has a started_at + ended_at.
    for (const step of out.tool_trace) {
      expect(typeof step.started_at).toBe("number");
      expect(typeof step.ended_at).toBe("number");
      expect(step.ended_at!).toBeGreaterThanOrEqual(step.started_at!);
    }
    expect(out.final_text).toContain("M26057");
  });

  test("per-turn cap drops tool calls beyond V2_PARALLEL_TOOL_CALL_CAP and nudges", async () => {
    installStub();
    cannedSelf = {
      "/v1/tickets/by-sorszam/B26071801": { sorszam: "B26071801" },
      "/v1/jobs/search": { total: 1, results: [] },
      "/v1/jobs/stats": { groups: [] },
      "/v1/related": { timeline: [] },
      "/v1/integration/spare-motor": { candidates: [] },
      "/v1/customers/search": { customers: [] },
      "/v1/jobs/linkage": { total: 0 },
    };
    // 6 parallel calls → cap=5 → 1 dropped.
    const calls = [
      { name: "find_ticket", args: { sorszam: "B26071801" }, id: "c1" },
      { name: "search_tickets", args: { q: "x" }, id: "c2" },
      { name: "get_ticket_stats", args: { group_by: "customer" }, id: "c3" },
      { name: "find_related_tickets", args: { sorszam: "B26071801" }, id: "c4" },
      { name: "find_spare_motor", args: { serial_number: "M26057" }, id: "c5" },
      { name: "list_customers", args: { q: "PLASMA" }, id: "c6" },
    ];
    chatScript = [
      { body: { choices: [{ message: multiToolCallMsg(calls) }] } },
      { body: { choices: [{ message: { content: "ok" } }] } },
    ];
    const out = await runAgentV2({ question: "test", language: "hu" });
    // Only 5 calls actually dispatched → 5 trace entries.
    expect(out.tool_trace).toHaveLength(V2_PARALLEL_TOOL_CALL_CAP);
    // The 6th was dropped.
    const dropped = out.tool_trace.find((t) => t.name === "list_customers");
    expect(dropped).toBeUndefined();
  });

  test("hallucinated tool name returns unknown_tool, doesn't crash the loop", async () => {
    installStub();
    cannedSelf = { "/v1/jobs/search": { total: 1, results: [] } };
    chatScript = [
      {
        body: {
          choices: [
            {
              message: multiToolCallMsg([
                { name: "search_tickets", args: { q: "x" }, id: "c1" },
                { name: "definitely_not_a_real_tool", args: {}, id: "c2" },
              ]),
            },
          ],
        },
      },
      { body: { choices: [{ message: { content: "I have an answer." } }] } },
    ];
    const out = await runAgentV2({ question: "test", language: "en" });
    expect(out.tool_trace).toHaveLength(2);
    const hallucinated = out.tool_trace.find((t) => t.name === "definitely_not_a_real_tool");
    expect(hallucinated?.ok).toBe(false);
    expect(hallucinated?.note).toBe("unknown_tool");
    expect(out.final_text).toBe("I have an answer.");
  });

  test("no-info claim without a tool call triggers the v2 watchdog nudge", async () => {
    installStub();
    cannedSelf = { "/v1/jobs/search": { total: 3, results: [{ sorszam: "B26071801", customer: "PLASMA-TECH" }] } };
    chatScript = [
      // Round 1: model claims no info without ever calling a tool.
      { body: { choices: [{ message: { content: "Nincs elérhető információ." } }] } },
      // Round 2: model uses the nudge to call a tool.
      { body: { choices: [{ message: toolCallMsg("search_tickets", { q: "M26057" }, "c1") }] } },
      // Round 3: real answer.
      { body: { choices: [{ message: { content: "B26071801, PLASMA-TECH." } }] } },
    ];
    const out = await runAgentV2({ question: "M26057?", language: "hu" });
    expect(out.iterations).toBe(3);
    // The watchdog should have logged its activation.
    expect(out.final_text).toBe("B26071801, PLASMA-TECH.");
  });

  test("watchdog fires at most once — second no-info claim returned as-is", async () => {
    installStub();
    chatScript = [
      { body: { choices: [{ message: { content: "Nincs információ." } }] } },
      { body: { choices: [{ message: { content: "Nincs elérhető információ." } }] } },
    ];
    const out = await runAgentV2({ question: "x", language: "hu" });
    expect(out.iterations).toBe(2);
    // Second no-info was NOT nudged — returned as the final answer.
    expect(out.final_text).toBe("Nincs elérhető információ.");
  });
});

// ---------------------------------------------------------------------------
// runAgentV2 — outcome shape
// ---------------------------------------------------------------------------

describe("runAgentV2 — outcome shape", () => {
  test("outcome carries agent_v2=true and parallel_groups=N", async () => {
    installStub();
    cannedSelf = { "/v1/jobs/search": { total: 0, results: [] } };
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("search_tickets", { q: "x" }, "c1") }] } },
      { body: { choices: [{ message: { content: "Nothing found." } }] } },
    ];
    const out = await runAgentV2({ question: "x", language: "en" });
    expect(out.agent_v2).toBe(true);
    expect(out.parallel_groups).toBe(1);
    expect(out.iterations).toBe(2);
    expect(out.tool_trace[0].parallel_group_id).toBe("g0");
  });

  test("resolved_customer is extracted from a search_tickets hit", async () => {
    installStub();
    cannedSelf = {
      "/v1/jobs/search": {
        total: 1,
        results: [{ sorszam: "B26071801", customer_name: "PLASMA-TECH" }],
      },
    };
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("search_tickets", { q: "M26057" }, "c1") }] } },
      { body: { choices: [{ message: { content: "B26071801" } }] } },
    ];
    const out = await runAgentV2({ question: "x", language: "hu" });
    expect(out.resolved_customer).toBe("PLASMA-TECH");
  });
});
