// Debug probe: replicate the failing sync soft-deadline test and dump detail.
// Run: bun _probe_softdeadline.ts  (from cmms-api)
import { startTestServer } from "./tests/harness";
import { buildFixture, cleanupFixture, type FixtureRow } from "./tests/fixtures/fixture";

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

const origFetch = globalThis.fetch;
let chatCalls: Array<{ url: string; options: RequestInit; t: number }> = [];

function toolCallMsg(name: string, args: unknown, id = "call-1") {
  return {
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
  };
}

async function main() {
  const fx = buildFixture(rows);
  const server = await startTestServer(fx);
  process.env.KILO_API_KEY = "kilo-test-key";
  process.env.CMMS_API_URL = server.url;
  process.env.CMMS_API_TOKEN_READ = server.readToken;
  process.env.CMMS_API_TOKEN_WRITE = server.writeToken;
  console.log("env AGENT_SOFT_DEADLINE_MS =", process.env.AGENT_SOFT_DEADLINE_MS);

  const cannedSelf: Record<string, unknown> = { "/v1/answer": { filters: {}, summary: "x" } };
  const script = [
    { body: { choices: [{ message: toolCallMsg("answer_question", { q: "x" }, "call-1") }] }, delayMs: 60 },
    { body: { choices: [{ message: { content: "Időből készült válasz." } }] } },
  ];
  const t0 = Date.now();
  chatCalls = [];
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (url.includes("/chat/completions")) {
      const step = script.shift() ?? {};
      chatCalls.push({ url, options: init ?? {}, t: Date.now() - t0 });
      const payload = step.body ?? { choices: [{ message: { content: "stub-ok" } }] };
      const make = () =>
        Promise.resolve(new Response(JSON.stringify(payload), { status: step.status ?? 200, headers: { "content-type": "application/json" } }));
      if (step.delayMs) {
        return new Promise<Response>((resolve) => setTimeout(() => make().then(resolve), step.delayMs));
      }
      return make();
    }
    const u = new URL(url);
    if (cannedSelf[u.pathname] !== undefined) {
      return Promise.resolve(new Response(JSON.stringify(cannedSelf[u.pathname]), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return origFetch(input, init);
  }) as typeof fetch;

  const r = await fetch(`${server.url}/v1/answer-agent`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${server.readToken}` },
    body: JSON.stringify({ q: "x", language: "hu", softDeadlineMs: 30 }),
  });
  const body: any = await r.json();
  console.log("status:", r.status);
  console.log("soft_deadline_forced:", body.soft_deadline_forced);
  console.log("final_text:", body.final_text);
  console.log("iterations:", body.iterations);
  console.log("chat calls:", chatCalls.length);
  for (const c of chatCalls) {
    const parsed = JSON.parse(String(c.options.body));
    console.log(`  call at +${c.t}ms tools=${Array.isArray(parsed.tools) ? parsed.tools.length : parsed.tools} tool_choice=${JSON.stringify(parsed.tool_choice)}`);
    const msgs = parsed.messages as Array<{ role: string; content: string }>;
    console.log("   system msgs:", msgs.filter((m) => m.role === "system").map((m) => m.content.slice(0, 60)));
  }

  globalThis.fetch = origFetch;
  server.stop();
  cleanupFixture(fx);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
