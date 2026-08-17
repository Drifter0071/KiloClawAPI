// Phase 5.6 — answer_question must call /v1/answer (the router), not
// /v1/jobs/search directly.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";
import { startTestServer, type TestServer } from "./harness";

const MCP_SERVER = join(import.meta.dir, "..", "mcp-server.ts");

const rows: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B26071801",
    "1": "2026.07.18",
    "AKTUÁLIS NÉV": "PLASMA-TECH SYSTEMS KFT.",
    "KÉSZÜLÉK TIPUSA": "NCT99;M-26057;SW-2.0;",
    "BEJELENTETT HIBA": "M26057 vezérlés kérdés",
    "ELVÉGZETT MUNKA": "tápegység csere",
    "NY/Z": 1,
  },
  {
    KEY: 2,
    "BEJELENTÉS SORSZÁMA": "B26061810",
    "1": "2026.06.18",
    "AKTUÁLIS NÉV": "HAJDU AUTOTECHNIKA IPARI ZRT.",
    "KÉSZÜLÉK TIPUSA": "EmL-610;M-09192;SW-1.0;",
    "BEJELENTETT HIBA": "X tengely golyós orsó csapágyak",
    "ELVÉGZETT MUNKA": "csapágy csere",
    "NY/Z": 0,
  },
  {
    KEY: 3,
    "BEJELENTÉS SORSZÁMA": "B25072420",
    "1": "2025.07.24",
    "AKTUÁLIS NÉV": "VÁMOSGÉP KFT.",
    "KÉSZÜLÉK TIPUSA": "WFQ-80;M-17191;SW-3.0;",
    "BEJELENTETT HIBA": "M17191 gép hiba",
    "ELVÉGZETT MUNKA": "javítás",
    "NY/Z": 0,
  },
  {
    KEY: 4,
    "BEJELENTÉS SORSZÁMA": "B26072218",
    "1": "2026.07.30",
    "AKTUÁLIS NÉV": "Teszt Ügyfél - MCP Skill",
    "KÉSZÜLÉK TIPUSA": "TMV-400;",
    "BEJELENTETT HIBA": "MCP skill teszt ticket",
    "ELVÉGZETT MUNKA": "",
    "NY/Z": 0,
  },
];

let fix: Fixture;
let srv: TestServer;
let mcp: McpProcess;

type JsonRpcMsg = { jsonrpc: "2.0"; id?: number; result?: any; error?: any; method?: string; params?: any };

class McpProcess {
  private proc: ChildProcess;
  private buf = "";
  private pending: ((msg: JsonRpcMsg) => void)[] = [];
  private nextId = 1;

  constructor(restUrl: string, readToken: string, writeToken: string) {
    this.proc = spawn("bun", ["run", MCP_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CMMS_API_URL: restUrl,
        CMMS_API_TOKEN_READ: readToken,
        CMMS_API_TOKEN_WRITE: writeToken,
      },
    });
    this.proc.stdout!.on("data", (d: Buffer) => {
      this.buf += d.toString();
      this.flush();
    });
  }
  private flush() {
    const lines = this.buf.split("\n");
    this.buf = lines.pop()!;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcMsg;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      if (this.pending.length > 0) this.pending.shift()!(msg);
    }
  }
  send(method: string, params?: any) {
    const id = this.nextId++;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }
  notify(method: string, params?: any) {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  recv(timeout = 5000): Promise<JsonRpcMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP recv timeout after ${timeout}ms`)), timeout);
      this.pending.push((m) => { clearTimeout(timer); resolve(m); });
      this.flush();
    });
  }
  async rpc(method: string, params?: any, timeout = 5000) {
    this.send(method, params);
    return this.recv(timeout);
  }
  async close() {
    this.proc.stdin!.end();
    await new Promise<void>((r) => {
      this.proc.on("close", () => r());
      setTimeout(() => { this.proc.kill("SIGTERM"); r(); }, 2000);
    });
  }
}

beforeAll(async () => {
  fix = buildFixture(rows);
  srv = await startTestServer(fix);
  mcp = new McpProcess(srv.url, srv.readToken, srv.writeToken);
  await mcp.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.1.0" },
  });
  mcp.notify("notifications/initialized");
});

afterAll(async () => {
  await mcp.close();
  srv.stop();
  cleanupFixture(fix);
});

async function ask(q: string, extra: Record<string, unknown> = {}) {
  const r = await mcp.rpc("tools/call", {
    name: "answer_question",
    arguments: { q, language: "hu", ...extra },
  });
  if (r.error) throw new Error(`answer_question returned error: ${JSON.stringify(r.error)}`);
  const text = r.result.content[0].text;
  return JSON.parse(text);
}

describe("answer_question uses the router (calls /v1/answer)", () => {
  test("M26057 question routes to device_tickets_list and returns the right ticket", async () => {
    const data = await ask("Milyen vezérlés található az M26057 gépen?");
    expect(data.intent).toBe("device_tickets_list");
    expect(data.primitive).toBe("search_tickets");
    expect(data.filters?.device).toBe("M26057");
    expect(data.total).toBe(1);
    expect(data.results?.[0]?.sorszam).toBe("B26071801");
  });

  test("M09192 part-spec question routes to part_spec (not a hit counter)", async () => {
    const data = await ask("X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál");
    expect(data.intent).toBe("part_spec");
    expect(data.primitive).toBe("search_tickets");
    expect(data.filters?.device).toBe("M09192");
    // The fixture has no extractable type/quantity for M09192 -> the
    // summary must be the honest not-found, never "N találat".
    expect(data.summary).toContain("M09192");
    expect(data.summary).not.toMatch(/^\d+ találat/);
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.results?.[0]?.sorszam).toBe("B26061810");
  });

  test("M17191 question routes to device_tickets_list and returns the right ticket", async () => {
    const data = await ask("Kérem az M17191 gép előéletét napjainktól 2024.05.10-ig visszamenőleg");
    expect(data.intent).toBe("device_tickets_list");
    expect(data.filters?.device).toBe("M17191");
    expect(data.total).toBe(1);
    expect(data.results?.[0]?.sorszam).toBe("B25072420");
  });

  test("summary is a non-empty Hungarian string", async () => {
    const data = await ask("Milyen vezérlés található az M26057 gépen?");
    expect(typeof data.summary).toBe("string");
    expect(data.summary.length).toBeGreaterThan(5);
  });

  test("follow_ups is a non-empty array", async () => {
    const data = await ask("Milyen vezérlés található az M26057 gépen?");
    expect(Array.isArray(data.follow_ups)).toBe(true);
    expect(data.follow_ups.length).toBeGreaterThan(0);
  });
});
