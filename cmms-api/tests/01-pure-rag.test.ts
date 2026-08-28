// Smoke + core tests for the pure-RAG rebuild.
//
// 1. RAG index builds from a fixture and returns chunks for a real
//    Hungarian question.
// 2. /v1/chat/completions (non-stream) returns an OpenAI-shaped
//    response with the cmms extension payload.
// 3. /v1/chat/completions (stream) emits well-formed SSE frames
//    and ends with [DONE].
// 4. The grounding gate rejects an LLM answer that invents a
//    sorszam not in the retrieved chunks (tested by feeding a
//    hand-crafted "rendered" string).
// 5. /v1/health reports the RAG row count.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";
import { startTestServer, authHeaders, type TestServer } from "./harness";
import { enforceGrounding, buildRagGround } from "../src/lib/grounding";
import type { RagHit } from "../src/lib/rag";

function makeHit(sorszam: string, body: string, customer: string | null, date: string | null): RagHit {
  return {
    sorszam,
    customer,
    device: null,
    reported_at_iso: date,
    kategoria: null,
    status: 1,
    top_chunks: [{ kind: "reported", body, score: 0.5 }],
    total_score: 0.5,
  };
}

const FIXTURE_ROWS: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B2408001",
    "1": "2024-08-15",
    "AKTUÁLIS NÉV": "ANDRITZ Kft.",
    "BEJELENTETT HIBA": "A NCT vezérlő lefagyott indítás után, kijelző nem reagál.",
    "ELVÉGZETT MUNKA": "Firmware frissítés, újraindítás, teszt üzem.",
    "NY/Z": 0,
    "KÉSZÜLÉK TIPUSA": "NCT-99 / TMV-4",
  },
  {
    KEY: 2,
    "BEJELENTÉS SORSZÁMA": "B2408002",
    "1": "2024-08-20",
    "AKTUÁLIS NÉV": "Metarad Kft.",
    "BEJELENTETT HIBA": "Hálózati kapcsolat megszakad, WiFi nem csatlakozik.",
    "ELVÉGZETT MUNKA": "Router reset, SSID újrakonfigurálás.",
    "NY/Z": 1,
    "KÉSZÜLÉK TIPUSA": "DA-200",
  },
  {
    KEY: 3,
    "BEJELENTÉS SORSZÁMA": "B2408003",
    "1": "2024-08-22",
    "AKTUÁLIS NÉV": "Trimble Hungary Kft.",
    "BEJELENTETT HIBA": "Szervomotor túlmelegedés, hűtés nem megfelelő.",
    "ELVÉGZETT MUNKA": "Hűtőventilátor csere, hőmérséklet ellenőrzés.",
    "NY/Z": 0,
    "KÉSZÜLÉK TIPUSA": "DPB-500",
  },
  {
    KEY: 4,
    "BEJELENTÉS SORSZÁMA": "B2408004",
    "1": "2024-08-25",
    "AKTUÁLIS NÉV": "Gildemeister Magyarország Kft.",
    "BEJELENTETT HIBA": "Kijelző pixelhiba, egyes sorok hiányoznak.",
    "ELVÉGZETT MUNKA": "LCD panel csere.",
    "NY/Z": 0,
    "KÉSZÜLÉK TIPUSA": "EML-300",
  },
  {
    KEY: 5,
    "BEJELENTÉS SORSZÁMA": "B2408005",
    "1": "2024-08-28",
    "AKTUÁLIS NÉV": "ANDRITZ Kft.",
    "BEJELENTETT HIBA": "Ismételt NCT vezérlő hiba, korábbi B2408001-hez hasonló.",
    "ELVÉGZETT MUNKA": "Diagnosztika folyamatban.",
    "NY/Z": 1,
    "KÉSZÜLÉK TIPUSA": "NCT-99",
  },
];

let fixture: Fixture;
let server: TestServer;

beforeEach(async () => {
  fixture = buildFixture(FIXTURE_ROWS);
  server = await startTestServer(fixture);
});

afterEach(() => {
  server.stop();
  cleanupFixture(fixture);
});

describe("RAG index", () => {
  test("builds non-empty index from fixture", () => {
    expect(server.rag.size()).toBeGreaterThan(0);
    // Each fixture row has at least 2 notes (reported + work), so the
    // chunk_meta side table should hold 10 rows.
    expect(server.rag.size()).toBeGreaterThanOrEqual(10);
  });

  test("/v1/health reports the RAG row count", async () => {
    const res = await fetch(`${server.url}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("pure-rag");
    expect(typeof body.rag_rows).toBe("number");
    expect(body.rag_rows).toBeGreaterThan(0);
  });
});

describe("/v1/chat/completions (non-stream)", () => {
  test("returns OpenAI-shaped response with cmms extension", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(server.readToken),
      body: JSON.stringify({
        model: "cmms",
        messages: [
          { role: "user", content: "Mi volt a B2408001 hiba?" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("cmms");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(typeof body.choices[0].message.content).toBe("string");
    expect(body.cmms).toBeTruthy();
    expect(body.cmms.mode).toBe("pure-rag");
    expect(body.cmms.hits_count).toBeGreaterThan(0);
    // The deterministic fallback should mention the sorszam.
    expect(body.choices[0].message.content).toContain("B2408001");
  });

  test("detects Hungarian language from diacritics", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(server.readToken),
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Mi a helyzet a NCT vezérlővel?" },
        ],
      }),
    });
    const body = (await res.json()) as any;
    expect(body.cmms.language).toBe("hu");
  });

  test("returns 400 when no user message", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(server.readToken),
      body: JSON.stringify({ model: "cmms", messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("returns 401 when bearer token is missing", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(res.status).toBe(401);
  });

  test("use_llm=false skips the LLM and ships deterministic", async () => {
    // Set a fake key to prove use_llm=false wins regardless.
    process.env.KILO_API_KEY = "test-fake-key";
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(server.readToken),
      body: JSON.stringify({
        use_llm: false,
        messages: [{ role: "user", content: "Mi a B2408001?" }],
      }),
    });
    const body = (await res.json()) as any;
    expect(body.cmms.used_llm).toBe(false);
    delete process.env.KILO_API_KEY;
  });
});

describe("/v1/chat/completions (stream)", () => {
  test("emits SSE frames ending with [DONE]", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(server.readToken),
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "Mi volt a B2408002?" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // Should contain at least one content frame and the terminator.
    expect(text).toContain("data: {");
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("[DONE]");
    // Should mention the sorszam somewhere in the streamed text.
    expect(text).toContain("B2408002");
  });
});

describe("Grounding gate", () => {
  test("rejects an LLM answer that invents a sorszam", () => {
    const hits = [
      makeHit("B2408001", "NCT vezérlő hiba", "ANDRITZ Kft.", "2024-08-15"),
    ];
    const llmText = "A B9999999 sorszámú jegyben...";
    const v = enforceGrounding(llmText, hits, "fallback");
    expect(v.ok).toBe(false);
    expect(v.rejected_facts.some((f) => f.kind === "sorszam" && f.value === "B9999999")).toBe(true);
  });

  test("accepts an LLM answer that only cites retrieved facts", () => {
    const hits = [
      makeHit("B2408001", "NCT vezérlő hiba", "ANDRITZ Kft.", "2024-08-15"),
    ];
    const llmText = "A B2408001 sorszámú jegyben ANDRITZ Kft.-nél NCT vezérlő hiba volt 2024-08-15-én.";
    const v = enforceGrounding(llmText, hits, "fallback");
    expect(v.ok).toBe(true);
    expect(v.rejected_facts).toHaveLength(0);
  });

  test("rejects a customer name that is not in the retrieved set", () => {
    const hits = [
      makeHit("B2408001", "x", "ANDRITZ Kft.", "2024-08-15"),
    ];
    const llmText = "A Fictional Customer Kft. is the issue.";
    const v = enforceGrounding(llmText, hits, "fallback");
    expect(v.ok).toBe(false);
    expect(v.rejected_facts.some((f) => f.kind === "customer")).toBe(true);
  });

  test("buildRagGround pulls sorszam, customer, and date from hits", () => {
    const hits = [
      makeHit("B2408001", "x", "ANDRITZ Kft.", "2024-08-15"),
    ];
    const g = buildRagGround(hits, "Mi a B2408001?");
    expect(g.sorszams.has("B2408001")).toBe(true);
    expect(g.dates.has("2024-08-15")).toBe(true);
    expect(g.customerTokens.has("andritz")).toBe(true);
    expect(g.customerTokens.has("kft")).toBe(true);
  });
});

describe("Recurring-problem search via RAG", () => {
  test("finds both NCT tickets in one search", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(server.readToken),
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Melyik jegyen volt NCT vezérlő hiba?" },
        ],
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.choices[0].message.content;
    // Both B2408001 and B2408005 mention NCT vezérlő hiba.
    expect(text).toContain("B2408001");
    expect(text).toContain("B2408005");
  });
});
