// Tests for the agentic Ask loop: src/lib/agent_tools.ts (tool registry
// + executor), src/lib/agent.ts (runAgent loop) and the
// POST /v1/answer-agent route (src/routes/agent.ts).
//
// Hard-fail contract (user decision 2026-08-13): LLM error / timeout /
// empty answer / iteration exhaustion → AgentFailure → 502 agent_failed.
// There is NO deterministic fallback. Write tools are allowed in the
// agent, but remove_ticket (permanent delete) and the legacy aliases
// (search_existing_tickets, search_by_category) are excluded.
//
// Env note: bun's test runner shares ONE process env across all files.
// beforeEach forces a deterministic baseline; route tests re-set
// CMMS_API_URL to the harness server so the agent's self-fetch hits the
// real REST surface.

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { AGENT_TOOLS, AGENT_TOOLS_OPENAI, callAgentTool } from "../src/lib/agent_tools";
import {
  AgentFailure,
  runAgent,
  AGENT_MAX_ITERATIONS,
  AGENT_LOOP_TIMEOUT_MS,
  AGENT_DEFAULT_BASE_URL,
} from "../src/lib/agent";
import { llmModel, LLM_DEFAULT_MODEL, LLM_DEFAULT_BASE_URL } from "../src/lib/llm";
import { startTestServer, type TestServer } from "./harness";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";

// ---------------------------------------------------------------------------
// Fetch stub: captures /chat/completions (scripted LLM) and canned
// self-fetch paths; everything else passes through to the real fetch so
// the harness server keeps working.
// ---------------------------------------------------------------------------

const origFetch = globalThis.fetch;

type ChatStep = {
  body?: unknown;
  status?: number;
  reject?: boolean;
  /** Never resolve — for timeout tests (rejects on abort). */
  never?: boolean;
};

let chatScript: ChatStep[] = [];
let chatCalls: Array<{ url: string; options: RequestInit }> = [];
let cannedSelf: Record<string, unknown> = {};
let selfCalls: Array<{ url: string; options: RequestInit }> = [];

function installStub(): void {
  chatCalls = [];
  selfCalls = [];
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
      selfCalls.push({ url, options: init ?? {} });
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

/** A chat/completions `message` with one tool call. */
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

// ---------------------------------------------------------------------------
// Env baseline (shared process env — see header comment)
// ---------------------------------------------------------------------------

// These mirror harness.ts's READ/WRITE constants. startTestServer sets the
// env to them, and the server validates the bearer against the env at
// request time, so route tests must keep exactly these values.
const TEST_READ = "test-read-token";
const TEST_WRITE = "test-write-token";

beforeEach(() => {
  delete process.env.KILO_API_KEY;
  delete process.env.KILO_MODEL;
  delete process.env.KILO_BASE_URL;
  delete process.env.CMMS_API_URL;
  process.env.CMMS_API_TOKEN_READ = TEST_READ;
  process.env.CMMS_API_TOKEN_WRITE = TEST_WRITE;
  chatScript = [];
  cannedSelf = {};
  chatCalls = [];
  selfCalls = [];
});

afterAll(() => {
  globalThis.fetch = origFetch;
  delete process.env.KILO_API_KEY;
  delete process.env.KILO_MODEL;
  delete process.env.KILO_BASE_URL;
  delete process.env.CMMS_API_URL;
});

// ---------------------------------------------------------------------------
// Registry guards
// ---------------------------------------------------------------------------

describe("agent tool registry", () => {
  test("25 tools: 19 read + 6 write; remove_ticket and legacy aliases excluded", () => {
    expect(AGENT_TOOLS).toHaveLength(25);
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).not.toContain("remove_ticket");
    expect(names).not.toContain("search_existing_tickets");
    expect(names).not.toContain("search_by_category");
    const write = AGENT_TOOLS.filter((t) => t.write);
    expect(write.map((t) => t.name).sort()).toEqual(
      [
        "add_ticket_tag",
        "close_ticket",
        "create_ticket",
        "modify_ticket",
        "set_ticket_category",
        "set_ticket_severity",
      ].sort(),
    );
    expect(AGENT_TOOLS.filter((t) => !t.write)).toHaveLength(19);
  });

  test("answer_question is tool #0 with required q", () => {
    expect(AGENT_TOOLS[0]!.name).toBe("answer_question");
    const openai = AGENT_TOOLS_OPENAI[0]!;
    expect(openai.type).toBe("function");
    expect(openai.function.name).toBe("answer_question");
    expect(openai.function.parameters.required).toContain("q");
  });

  test("get_ticket_stats has the 9-dim group_by enum + severity enum", () => {
    const stats = AGENT_TOOLS.find((t) => t.name === "get_ticket_stats")!;
    const dims = (stats.props.group_by as { e?: string[] }).e;
    expect(dims).toEqual([
      "customer",
      "device",
      "technician",
      "status",
      "month",
      "kategoria",
      "sulyossag",
      "machine_type",
      "controller",
    ]);
    const sev = (stats.props.sulyossag as { e?: string[] }).e;
    expect(sev).toEqual(["alacsony", "kozepes", "magas", "kritikus"]);
  });

  test("OpenAI payload mirrors the registry (names, required, bilingual description)", () => {
    expect(AGENT_TOOLS_OPENAI).toHaveLength(AGENT_TOOLS.length);
    for (let i = 0; i < AGENT_TOOLS.length; i++) {
      const def = AGENT_TOOLS[i]!;
      const openai = AGENT_TOOLS_OPENAI[i]!;
      expect(openai.function.name).toBe(def.name);
      expect(openai.function.description.length).toBeGreaterThan(20);
      const required = openai.function.parameters.required as string[];
      for (const [name, spec] of Object.entries(def.props)) {
        if (spec.r) expect(required).toContain(name);
      }
    }
  });

  test("write-tool body rewrites produce the REST shapes", () => {
    const close = AGENT_TOOLS.find((t) => t.name === "close_ticket")!;
    expect(close.endpoint).toBe("/v1/tickets/:key/close");
    expect(close.body!({ key: 42, text: "kész", author: "GB" })).toEqual({ text: "kész", author: "GB" });
    expect(close.body!({ key: 42 })).toEqual({});
    const cat = AGENT_TOOLS.find((t) => t.name === "set_ticket_category")!;
    expect(cat.body!({ sorszam: "B26072216", problem_kategoria: "Szoftver hiba" })).toEqual({
      sorszam: "B26072216",
      problem_kategoria: "Szoftver hiba",
    });
    const tag = AGENT_TOOLS.find((t) => t.name === "add_ticket_tag")!;
    expect(tag.body!({ key: 7, nev: "garancia" })).toEqual({ nev: "garancia" });
  });

  test("loop constants are sane", () => {
    expect(AGENT_MAX_ITERATIONS).toBe(10);
    expect(AGENT_LOOP_TIMEOUT_MS).toBe(120_000);
    expect(AGENT_DEFAULT_BASE_URL).toBe("http://127.0.0.1:8787");
  });
});

// ---------------------------------------------------------------------------
// callAgentTool executor (unit, canned self-fetch)
// ---------------------------------------------------------------------------

describe("callAgentTool executor", () => {
  test("unknown tool name → ok:false with a steer", async () => {
    const out = await callAgentTool("nope", {}, { baseUrl: "u", readToken: "r", writeToken: "" });
    expect(out.ok).toBe(false);
    expect(out.text).toContain("Unknown tool");
  });

  test("GET tools serialize args to the query string", async () => {
    cannedSelf["/v1/integration/serviz/by-j-szam"] = { j: "J00001", tetelek: [] };
    installStub();
    const out = await callAgentTool(
      "get_serviz_ticket",
      { j: "J00001" },
      { baseUrl: "http://x", readToken: "r", writeToken: "" },
    );
    expect(out.ok).toBe(true);
    expect(selfCalls).toHaveLength(1);
    expect(selfCalls[0]!.url).toBe("http://x/v1/integration/serviz/by-j-szam?j=J00001");
  });

  test("close_ticket substitutes :key and strips empty fields from the body", async () => {
    cannedSelf["/v1/tickets/42/close"] = { ok: true };
    installStub();
    const out = await callAgentTool(
      "close_ticket",
      { key: 42, text: "kész" },
      { baseUrl: "http://x", readToken: "r", writeToken: "w" },
    );
    expect(out.ok).toBe(true);
    expect(selfCalls[0]!.url).toBe("http://x/v1/tickets/42/close");
    expect((selfCalls[0]!.options as RequestInit).method).toBe("POST");
    expect(JSON.parse((selfCalls[0]!.options as RequestInit).body as string)).toEqual({ text: "kész" });
    expect((selfCalls[0]!.options.headers as Record<string, string>).authorization).toBe("Bearer w");
  });
});

// ---------------------------------------------------------------------------
// runAgent loop (stubbed LLM + canned REST)
// ---------------------------------------------------------------------------

describe("runAgent loop", () => {
  test("tool_calls → tool results → final text; outcome carries trace/customer/model/language", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_TOKEN_READ = "unit-read-token";
    cannedSelf["/v1/answer"] = { filters: { customer: "ANDRITZ KFT." }, summary: "x", mode: "answer" };
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("answer_question", { q: "andritz tavaly" }) }] } },
      { body: { choices: [{ message: { content: "  Az ANDRITZ-nak 3 nyitott jegye volt tavaly.  " } }] } },
    ];
    installStub();
    const out = await runAgent({ question: "andritz tavaly", language: "hu" }, { baseUrl: "http://127.0.0.1:8787" });
    expect(out.final_text).toBe("Az ANDRITZ-nak 3 nyitott jegye volt tavaly.");
    expect(out.tool_trace).toEqual([{ name: "answer_question", args: { q: "andritz tavaly" }, ok: true }]);
    expect(out.iterations).toBe(2);
    expect(out.model).toBe(llmModel());
    expect(out.language).toBe("hu");
    expect(out.resolved_customer).toBe("ANDRITZ KFT.");
    // self-fetch hit the configured baseUrl with the READ token
    expect(selfCalls).toHaveLength(1);
    expect(selfCalls[0]!.url).toBe("http://127.0.0.1:8787/v1/answer");
    expect((selfCalls[0]!.options as RequestInit).method).toBe("POST");
    expect((selfCalls[0]!.options.headers as Record<string, string>).authorization).toBe("Bearer unit-read-token");
  });

  test("chat request carries the 25-tool payload, tool_choice auto, temp 0, auth header", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ body: { choices: [{ message: { content: "kész" } }] } }];
    installStub();
    const out = await runAgent({ question: "hé", language: "en" }, { baseUrl: "http://127.0.0.1:8787" });
    expect(out.language).toBe("en");
    expect(chatCalls).toHaveLength(1);
    const { url, options } = chatCalls[0]!;
    expect(url).toBe(`${LLM_DEFAULT_BASE_URL}/chat/completions`);
    expect((options.headers as Record<string, string>).authorization).toBe("Bearer kilo-test-key");
    const body = JSON.parse(options.body as string) as any;
    expect(body.model).toBe(llmModel());
    expect(body.temperature).toBe(0);
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toHaveLength(25);
    expect(body.tools[0].function.name).toBe("answer_question");
    expect(body.messages[0]!.role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: "hé" });
  });

  test("no KILO_API_KEY → AgentFailure (not configured)", async () => {
    installStub();
    await expect(runAgent({ question: "x", language: "hu" }, { baseUrl: "u" })).rejects.toThrow(
      /not configured/,
    );
  });

  test("LLM non-2xx → AgentFailure", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ status: 502 }];
    installStub();
    await expect(runAgent({ question: "x", language: "hu" }, { baseUrl: "u" })).rejects.toBeInstanceOf(
      AgentFailure,
    );
  });

  test("LLM network error → AgentFailure", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ reject: true }];
    installStub();
    await expect(runAgent({ question: "x", language: "hu" }, { baseUrl: "u" })).rejects.toBeInstanceOf(
      AgentFailure,
    );
  });

  test("LLM empty final answer → AgentFailure", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ body: { choices: [{ message: { content: "   " } }] } }];
    installStub();
    await expect(runAgent({ question: "x", language: "hu" }, { baseUrl: "u" })).rejects.toThrow(
      /empty final answer/,
    );
  });

  test("LLM response without choices[0].message → AgentFailure", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ body: { foo: "bar" } }];
    installStub();
    await expect(runAgent({ question: "x", language: "hu" }, { baseUrl: "u" })).rejects.toBeInstanceOf(
      AgentFailure,
    );
  });

  test("timeoutMs 0 → immediate AgentFailure (loop deadline)", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    installStub();
    await expect(runAgent({ question: "x", language: "hu" }, { baseUrl: "u", timeoutMs: 0 })).rejects.toThrow(
      /timed out/,
    );
  });

  test("LLM that never resolves → AgentFailure (per-round abort)", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ never: true }];
    installStub();
    await expect(
      runAgent({ question: "x", language: "hu" }, { baseUrl: "u", timeoutMs: 60 }),
    ).rejects.toBeInstanceOf(AgentFailure);
  });

  test("iteration exhaustion → AgentFailure", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_TOKEN_READ = "unit-read-token";
    cannedSelf["/v1/answer"] = { filters: {}, summary: "x" };
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("answer_question", { q: "x" }, "call-1") }] } },
      { body: { choices: [{ message: toolCallMsg("answer_question", { q: "x" }, "call-2") }] } },
    ];
    installStub();
    await expect(
      runAgent({ question: "x", language: "hu" }, { baseUrl: "http://127.0.0.1:8787", maxIterations: 2 }),
    ).rejects.toThrow(/exhausted 2 tool iterations/);
  });

  test("a failing tool lands in the trace as ok:false and the loop continues", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_TOKEN_READ = "unit-read-token";
    cannedSelf["/v1/answer"] = { filters: {}, summary: "x" };
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("answer_question", { q: "x" }, "call-1") }] } },
      { body: { choices: [{ message: toolCallMsg("bogus_tool", {}, "call-2") }] } },
      { body: { choices: [{ message: { content: "Végül megvan." } }] } },
    ];
    installStub();
    const out = await runAgent({ question: "x", language: "hu" }, { baseUrl: "http://127.0.0.1:8787" });
    expect(out.tool_trace).toHaveLength(2);
    expect(out.tool_trace[0]).toMatchObject({ name: "answer_question", ok: true });
    expect(out.tool_trace[1]).toMatchObject({ name: "bogus_tool", ok: false });
    expect(out.final_text).toBe("Végül megvan.");
  });

  test("malformed tool arguments → args._raw, still recorded", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_TOKEN_READ = "unit-read-token";
    cannedSelf["/v1/answer"] = { filters: {}, summary: "x" };
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("answer_question", "{not json", "call-1") }] } },
      { body: { choices: [{ message: { content: "ok" } }] } },
    ];
    installStub();
    const out = await runAgent({ question: "x", language: "hu" }, { baseUrl: "http://127.0.0.1:8787" });
    expect((out.tool_trace[0]!.args as Record<string, unknown>)._raw).toBe("{not json");
  });

  test("write tool without write token → ok:false 'no write token', no REST call", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_TOKEN_READ = "unit-read-token";
    delete process.env.CMMS_API_TOKEN_WRITE;
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("create_ticket", { customer_name: "X" }) }] } },
      { body: { choices: [{ message: { content: "Létrehozva." } }] } },
    ];
    installStub();
    const out = await runAgent({ question: "nyiss egy jegyet X-nek", language: "hu" }, { baseUrl: "u" });
    expect(out.tool_trace[0]).toMatchObject({ name: "create_ticket", ok: false, note: "no write token" });
    expect(selfCalls).toHaveLength(0);
  });

  test("write tool with write token → runs with the WRITE token", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_TOKEN_READ = "unit-read-token";
    process.env.CMMS_API_TOKEN_WRITE = "unit-write-token";
    cannedSelf["/v1/tickets/create"] = { ok: true, key: 99 };
    chatScript = [
      { body: { choices: [{ message: toolCallMsg("create_ticket", { customer_name: "X" }) }] } },
      { body: { choices: [{ message: { content: "Létrehozva." } }] } },
    ];
    installStub();
    const out = await runAgent({ question: "nyiss jegyet X-nek", language: "hu" }, { baseUrl: "http://127.0.0.1:8787" });
    expect(out.tool_trace[0]).toMatchObject({ name: "create_ticket", ok: true });
    expect(selfCalls).toHaveLength(1);
    expect((selfCalls[0]!.options.headers as Record<string, string>).authorization).toBe("Bearer unit-write-token");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/answer-agent route (real harness server, LLM stubbed)
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

afterAll(() => {
  server.stop();
  cleanupFixture(fx);
});

async function askAgent(q: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${server.url}/v1/answer-agent`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${server.readToken}` },
    body: JSON.stringify({ q, ...extra }),
  });
  return { status: r.status, body: (await r.json()) as any };
}

describe("POST /v1/answer-agent", () => {
  test("missing/blank q → 400 missing_q", async () => {
    const { status, body } = await askAgent("   ");
    expect(status).toBe(400);
    expect(body.error.code).toBe("missing_q");
  });

  test("no Kilo key → 503 agent_unconfigured", async () => {
    installStub();
    const { status, body } = await askAgent("M26057 vezérlés");
    expect(status).toBe(503);
    expect(body.error.code).toBe("agent_unconfigured");
  });

  test("full round-trip: answer_question → final text with resolved customer", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url; // agent self-fetch hits the harness server
    const q = "mi volt a PLASMA-TECH SYSTEMS KFT.-nél?";
    // Whatever the deterministic router extracts as filters.customer for
    // this question is what the agent must echo back as resolved_customer
    // (it drives the SPA's per-client thread split). Read it from a probe
    // call so the test tracks the router instead of baking in its output.
    const probe = (await (
      await fetch(`${server.url}/v1/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${server.readToken}` },
        body: JSON.stringify({ q, language: "hu" }),
      })
    ).json()) as any;
    const expectedCustomer = probe.filters?.customer ?? null;
    expect(typeof expectedCustomer).toBe("string");
    expect((expectedCustomer as string).length).toBeGreaterThan(0);

    chatScript = [
      {
        body: {
          choices: [
            {
              message: toolCallMsg("answer_question", { q }, "call-1"),
            },
          ],
        },
      },
      { body: { choices: [{ message: { content: "A PLASMA-TECH SYSTEMS KFT. jegyzetei rendben." } }] } },
    ];
    installStub();
    const { status, body } = await askAgent(q);
    expect(status).toBe(200);
    expect(body.final_text).toBe("A PLASMA-TECH SYSTEMS KFT. jegyzetei rendben.");
    expect(body.iterations).toBe(2);
    expect(body.model).toBe(llmModel());
    expect(body.language).toBe("hu");
    expect(body.tool_trace).toHaveLength(1);
    expect(body.tool_trace[0]).toMatchObject({ name: "answer_question", ok: true });
    expect(body.resolved_customer).toBe(expectedCustomer);
  });

  test("language: en is echoed in the outcome", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ body: { choices: [{ message: { content: "done" } }] } }];
    installStub();
    const { status, body } = await askAgent("hello", { language: "en" });
    expect(status).toBe(200);
    expect(body.language).toBe("en");
    expect(body.final_text).toBe("done");
    expect(body.tool_trace).toHaveLength(0);
    expect(body.iterations).toBe(1);
  });

  test("LLM non-2xx → 502 agent_failed", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ status: 502 }];
    installStub();
    const { status, body } = await askAgent("M26057 vezérlés");
    expect(status).toBe(502);
    expect(body.error.code).toBe("agent_failed");
  });

  test("LLM empty final answer → 502 agent_failed", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ body: { choices: [{ message: { content: "   " } }] } }];
    installStub();
    const { status, body } = await askAgent("M26057 vezérlés");
    expect(status).toBe(502);
    expect(body.error.code).toBe("agent_failed");
  });

  test("iteration exhaustion → 502 agent_failed", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    // The route runs with the default 10-iteration cap — every round
    // returns a tool call, so the loop burns through all 10 and fails.
    for (let i = 0; i < 10; i += 1) {
      chatScript.push({
        body: { choices: [{ message: toolCallMsg("answer_question", { q: "x" }, `call-${i}`) }] },
      });
    }
    installStub();
    const { status, body } = await askAgent("x");
    expect(status).toBe(502);
    expect(body.error.code).toBe("agent_failed");
  });
});
