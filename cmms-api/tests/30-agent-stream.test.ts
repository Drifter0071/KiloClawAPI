// Tests for the streaming Ask surface (2026-08-19 redesign):
//   - POST /v1/answer-agent/stream — SSE frames (status / tool_start /
//     tool_done / token / answer / error) relayed from runAgentStream;
//   - same-thread history + machine-scope context injection into the
//     chat payload (features #3 + #6);
//   - GET /v1/devices — substring device search for the machine picker.
//
// The LLM is stubbed with a scripted SSE /chat/completions (stream:true),
// so the whole runAgentStream loop executes for real — token events flow
// only during pure-content rounds, tool rounds emit tool_start/tool_done.
//
// Env note: bun's test runner shares ONE process env across all files,
// so every test sets its own KILO_* / CMMS_API_* baseline (mirrors
// tests/29-agent.test.ts).

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { llmModel } from "../src/lib/llm";
import { startTestServer, authHeaders, type TestServer } from "./harness";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";

const origFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Scripted streaming LLM stub
// ---------------------------------------------------------------------------

type ChatStep = {
  /** SSE chunk strings for the /chat/completions body (stream:true). */
  chunks?: string[];
  status?: number;
  reject?: boolean;
};

let chatScript: ChatStep[] = [];
let chatCalls: Array<{ url: string; options: RequestInit }> = [];
let cannedSelf: Record<string, unknown> = {};

/** One `data:` frame of an OpenAI-compatible streaming delta. */
function deltaChunk(delta: unknown): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

/** The terminal SSE frame of a streaming round. */
const DONE_CHUNK = "data: [DONE]\n\n";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function installStub(): void {
  chatCalls = [];
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (url.includes("/chat/completions")) {
      chatCalls.push({ url, options: init ?? {} });
      const step = chatScript.shift() ?? {};
      if (step.reject) return Promise.reject(new Error("ECONNRESET"));
      if (step.status !== undefined && step.status !== 200) {
        return Promise.resolve(new Response("boom", { status: step.status }));
      }
      const body = new Response(sseBody(step.chunks ?? []), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
      return Promise.resolve(body);
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

/** Parses raw SSE text into frames (event name + data payload). */
function parseSse(text: string): Array<{ event: string; data: string }> {
  return text
    .split("\n\n")
    .filter((f) => f.trim().length > 0)
    .map((frame) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      return { event, data: dataLines.join("\n") };
    });
}

// ---------------------------------------------------------------------------
// Fixture + server
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

const TEST_READ = "test-read-token";
const TEST_WRITE = "test-write-token";

let server: TestServer;
let fx: Fixture;

beforeAll(async () => {
  fx = buildFixture(rows);
  server = await startTestServer(fx);
});

afterAll(() => {
  server.stop();
  cleanupFixture(fx);
  globalThis.fetch = origFetch;
  delete process.env.KILO_API_KEY;
  delete process.env.KILO_MODEL;
  delete process.env.KILO_BASE_URL;
  delete process.env.CMMS_API_URL;
});

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
});

// ---------------------------------------------------------------------------
// POST /v1/answer-agent/stream
// ---------------------------------------------------------------------------

async function askStream(q: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${server.url}/v1/answer-agent/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${server.readToken}` },
    body: JSON.stringify({ q, ...extra }),
  });
  return {
    status: r.status,
    contentType: r.headers.get("content-type") ?? "",
    text: await r.text(),
  };
}

describe("POST /v1/answer-agent/stream", () => {
  test("missing/blank q → 400 missing_q as JSON (not SSE)", async () => {
    const { status, contentType, text } = await askStream("   ");
    expect(status).toBe(400);
    expect(contentType).toContain("application/json");
    expect(JSON.parse(text).error.code).toBe("missing_q");
  });

  test("no Kilo key → 503 agent_unconfigured as JSON", async () => {
    const { status, text } = await askStream("M26057 vezérlés");
    expect(status).toBe(503);
    expect(JSON.parse(text).error.code).toBe("agent_unconfigured");
  });

  test("full round-trip: status → tool_start/tool_done → token → answer (terminal)", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    process.env.CMMS_API_TOKEN_READ = "unit-read-token";
    const q = "mi történt az M26057-tel?";
    cannedSelf["/v1/answer"] = {
      filters: { customer: "PLASMA-TECH SYSTEMS KFT." },
      summary: "x",
      mode: "answer",
    };
    // Round 1: tool round (streamed tool_calls deltas). Round 2: final
    // answer (streamed content deltas → token events).
    chatScript = [
      {
        chunks: [
          deltaChunk({ role: "assistant" }),
          deltaChunk({
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "answer_question", arguments: JSON.stringify({ q }) },
              },
            ],
          }),
          DONE_CHUNK,
        ],
      },
      {
        chunks: [
          deltaChunk({ role: "assistant" }),
          deltaChunk({ content: "Válasz: " }),
          deltaChunk({ content: "3 nyitott jegy" }),
          DONE_CHUNK,
        ],
      },
    ];
    installStub();

    const { status, contentType, text } = await askStream(q);
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");

    const frames = parseSse(text);
    const events = frames.map((f) => f.event);
    // start → searching → tool_start → tool_done → searching → token ×2 → answer
    expect(events[0]).toBe("status");
    expect(events).toEqual([
      "status",
      "status",
      "tool_start",
      "tool_done",
      "status",
      "token",
      "token",
      "answer",
    ]);
    expect(events.at(-1)).toBe("answer");

    const statuses = frames.filter((f) => f.event === "status").map((f) => JSON.parse(f.data).phase);
    expect(statuses[0]).toBe("start");
    expect(statuses[1]).toBe("searching");

    const toolStart = JSON.parse(frames.find((f) => f.event === "tool_start")!.data);
    expect(toolStart.name).toBe("answer_question");
    expect(toolStart.args.q).toBe(q);

    const toolDone = JSON.parse(frames.find((f) => f.event === "tool_done")!.data);
    expect(toolDone.name).toBe("answer_question");
    expect(toolDone.ok).toBe(true);

    const tokens = frames.filter((f) => f.event === "token").map((f) => JSON.parse(f.data).text);
    expect(tokens.join("")).toBe("Válasz: 3 nyitott jegy");

    const outcome = JSON.parse(frames.at(-1)!.data);
    expect(outcome.final_text).toBe("Válasz: 3 nyitott jegy");
    expect(outcome.tool_trace).toEqual([{ name: "answer_question", args: { q }, ok: true }]);
    expect(outcome.iterations).toBe(2);
    expect(outcome.model).toBe(llmModel());
    expect(outcome.language).toBe("hu");
    expect(outcome.resolved_customer).toBe("PLASMA-TECH SYSTEMS KFT.");
    expect(typeof outcome.answer_id).toBe("string");
    expect(outcome.answer_id.length).toBeGreaterThan(0);
    expect(outcome.soft_deadline_forced).toBe(false);
  });

  test("LLM non-2xx → single `error` frame (agent_failed, hard-fail)", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    chatScript = [{ status: 502 }];
    installStub();
    const { status, contentType, text } = await askStream("M26057 vezérlés");
    expect(status).toBe(200); // SSE stream started; the failure is a frame, not an HTTP error
    expect(contentType).toContain("text/event-stream");
    const frames = parseSse(text);
    expect(frames.map((f) => f.event)).toContain("error");
    const err = JSON.parse(frames.find((f) => f.event === "error")!.data);
    expect(err.code).toBe("agent_failed");
    expect(typeof err.message).toBe("string");
  });

  test("history + machine-scope context are injected into the chat payload in order", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    chatScript = [
      { chunks: [deltaChunk({ role: "assistant" }), deltaChunk({ content: "kész" }), DONE_CHUNK] },
    ];
    installStub();

    const { status } = await askStream("M26057 állapota?", {
      history: [
        { role: "user", text: "Milyen gépeitek vannak?" },
        { role: "assistant", text: "Van egy M-26057." },
      ],
      context: { device: "M-26057" },
    });
    expect(status).toBe(200);

    expect(chatCalls).toHaveLength(1);
    const body = JSON.parse(chatCalls[0]!.options.body as string) as any;
    expect(body.stream).toBe(true);
    expect(body.tools).toBeDefined(); // tool round had the tool surface

    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.role).toBe("system");
    // Context scope system message sits between the system prompt and the history.
    expect(msgs[1]!.role).toBe("system");
    expect(msgs[1]!.content).toContain("device: M-26057");
    // 2026-08-24: tightened the SCOPE wording so the model treats the
    // pre-picked device as AUTHORITATIVE (must reach tool calls even
    // when the question text doesn't repeat it). Old copy said
    // "DEFAULT scope"; the new copy says "AUTHORITATIVE filter".
    expect(msgs[1]!.content).toContain("AUTHORITATIVE filter");
    // Then the prior turns, in chronological order, then the question.
    expect(msgs[2]).toEqual({ role: "user", content: "Milyen gépeitek vannak?" });
    expect(msgs[3]).toEqual({ role: "assistant", content: "Van egy M-26057." });
    expect(msgs[4]).toEqual({ role: "user", content: "M26057 állapota?" });
    expect(msgs).toHaveLength(5);
  });

  // 2026-08-24: when the SCOPE carries a device / customer but the
  // user's question text does NOT mention it, the server prepends a
  // short marker ([Gép: M-17191] …) to the question so the
  // deterministic router AND the LLM both see the entity in the
  // question. The system-prompt-only approach was unreliable — the
  // model sometimes called find_related_tickets WITHOUT the SCOPE
  // device and got 0 CMMS hits even though 12 in-window tickets
  // existed. (User example: "Kérem a gép előéletét 2024.05.10-től"
  // with M17191 picked → AI returned cross-DB 2021-2023 entries
  // instead of the 12 in-window CMMS tickets.)
  test("machine-scope context is also prepended into the question text when the question doesn't repeat it", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    chatScript = [
      { chunks: [deltaChunk({ role: "assistant" }), deltaChunk({ content: "kész" }), DONE_CHUNK] },
    ];
    installStub();

    const { status } = await askStream("kérem az előzményeket", {
      context: { device: "M17191" },
    });
    expect(status).toBe(200);

    expect(chatCalls).toHaveLength(1);
    const body = JSON.parse(chatCalls[0]!.options.body as string) as any;
    const msgs = body.messages as Array<{ role: string; content: string }>;
    const userMsg = msgs[msgs.length - 1]!;
    expect(userMsg.role).toBe("user");
    // The user-typed question had no machine mention; the server
    // prepended [Gép: M17191] so the model AND the router see it.
    expect(userMsg.content).toBe("[Gép: M17191] kérem az előzményeket");
  });

  test("machine-scope marker is NOT prepended when the question already mentions the device", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    chatScript = [
      { chunks: [deltaChunk({ role: "assistant" }), deltaChunk({ content: "kész" }), DONE_CHUNK] },
    ];
    installStub();

    const { status } = await askStream("M17191 előzményei", {
      context: { device: "M17191" },
    });
    expect(status).toBe(200);

    const body = JSON.parse(chatCalls[0]!.options.body as string) as any;
    const msgs = body.messages as Array<{ role: string; content: string }>;
    const userMsg = msgs[msgs.length - 1]!;
    expect(userMsg.content).toBe("M17191 előzményei");
  });

  test("history beyond 12 turns is clamped server-side", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    chatScript = [
      { chunks: [deltaChunk({ role: "assistant" }), deltaChunk({ content: "ok" }), DONE_CHUNK] },
    ];
    installStub();

    const history = Array.from({ length: 14 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn-${i}`,
    }));
    await askStream("x", { history });
    const body = JSON.parse(chatCalls[0]!.options.body as string) as any;
    // system + context absent + 12 clamped turns + question
    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(14);
    // The LAST 12 turns survive (turns 2..13), the first two are dropped.
    expect(msgs[1]!.content).toBe("turn-2");
    expect(msgs[12]!.content).toBe("turn-13");
  });

  test("no history/context → plain system + question only", async () => {
    process.env.KILO_API_KEY = "kilo-test-key";
    process.env.CMMS_API_URL = server.url;
    chatScript = [
      { chunks: [deltaChunk({ role: "assistant" }), deltaChunk({ content: "hé" }), DONE_CHUNK] },
    ];
    installStub();
    await askStream("hé");
    const body = JSON.parse(chatCalls[0]!.options.body as string) as any;
    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]).toEqual({ role: "user", content: "hé" });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/devices — machine-scope picker
// ---------------------------------------------------------------------------

async function devices(q?: string, limit?: number) {
  const qs = new URLSearchParams();
  if (q !== undefined) qs.set("q", q);
  if (limit !== undefined) qs.set("limit", String(limit));
  const r = await fetch(`${server.url}/v1/devices?${qs.toString()}`, {
    headers: authHeaders(server.readToken),
  });
  return { status: r.status, body: (await r.json()) as any };
}

describe("GET /v1/devices", () => {
  test("q shorter than 2 chars → empty list", async () => {
    const { status, body } = await devices("a");
    expect(status).toBe(200);
    expect(body.devices).toEqual([]);
  });

  test("substring search finds the fixture device (exact)", async () => {
    const { body } = await devices("M-26057");
    expect(body.devices.length).toBeGreaterThan(0);
    expect(body.devices[0]!.name).toBe("M-26057");
    expect(body.devices[0]!.tickets).toBe(1);
    expect(body.q).toBe("M-26057");
  });

  test("hyphen/space folding: M26057 matches M-26057", async () => {
    const { body } = await devices("M26057");
    expect(body.devices.some((d: { name: string }) => d.name === "M-26057")).toBe(true);
  });

  test("case-insensitive match", async () => {
    const { body } = await devices("m-26057");
    expect(body.devices.some((d: { name: string }) => d.name === "M-26057")).toBe(true);
  });

  test("limit is clamped to 1..50", async () => {
    const lo = await devices("M", 0);
    expect(lo.body.limit).toBe(1);
    const hi = await devices("M", 999);
    expect(hi.body.limit).toBe(50);
  });

  test("unknown device → empty list", async () => {
    const { body } = await devices("ZZ-99999");
    expect(body.devices).toEqual([]);
  });
});
