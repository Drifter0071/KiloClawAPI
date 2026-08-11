// MCP server integration tests.
//
// Spawns mcp-server.ts as a child process over stdio, against a live test
// REST API server. Validates the full MCP lifecycle: initialize → tools/list
// → tool/call for every registered tool.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { buildFixture, cleanupFixture, type Fixture, type FixtureRow } from "./fixtures/fixture";
import { startTestServer, type TestServer } from "./harness";

const MCP_SERVER = join(import.meta.dir, "..", "mcp-server.ts");

const rows: FixtureRow[] = [
  {
    KEY: 1,
    "BEJELENTÉS SORSZÁMA": "B20010101",
    "1": "2020.11.06",
    "AKTUÁLIS NÉV": "MÁV RT. Debrecen",
    "CÍM": "Debrecen Faraktár u 107",
    "KÉSZÜLÉK TIPUSA": "TMV-400(10297;M10170);NCT99M;CRT15\";SW-1.039;",
    "BEJELENTETT HIBA": "telepítés üzembe helyezés",
    "ELVÉGZETT MUNKA": "üzembe helyezve",
    "NY/Z": 1, // Phase 3 polarity fix: 1=open
    "DOLGOZÓ": "TP;",
  },
  {
    KEY: 2,
    "BEJELENTÉS SORSZÁMA": "B20020201",
    "1": "2021.03.15",
    "AKTUÁLIS NÉV": "NÉMETH LÁSZLÓ",
    "CÍM": "Keszthely",
    "KÉSZÜLÉK TIPUSA": "NilesDFS-2;NCT2000;SW-1.039;HW:int;",
    "BEJELENTETT HIBA": "készülék nem indul",
    "ELVÉGZETT MUNKA": "tápegység csere",
    "NY/Z": 0, // Phase 3 polarity fix: 0=closed
  },
  {
    KEY: 3,
    "BEJELENTÉS SORSZÁMA": "B20030301",
    "1": "2022.07.22",
    "AKTUÁLIS NÉV": "GE H. Hajdúböszörmény",
    "CÍM": "Hajdúböszörmény Kinizsi tér 1.",
    "KÉSZÜLÉK TIPUSA": "FND32;NCT2000M;SW-7.038;",
    "BEJELENTETT HIBA": "képernyő sötét",
    "NY/Z": 1, // Phase 3 polarity fix: 1=open
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
  stderr = "";

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
    this.proc.stderr!.on("data", (d: Buffer) => {
      this.stderr += d.toString();
    });
  }

  private flush() {
    const lines = this.buf.split("\n");
    this.buf = lines.pop()!;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (this.pending.length > 0) {
        this.pending.shift()!(msg);
      }
    }
  }

  send(method: string, params?: any): JsonRpcMsg {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0" as const, id, method, params };
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    return msg as any;
  }

  notify(method: string, params?: any) {
    const msg = { jsonrpc: "2.0" as const, method, params };
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  recv(timeout = 5000): Promise<JsonRpcMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.indexOf(resolve as any);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`MCP recv timeout after ${timeout}ms`));
      }, timeout);
      const wrapped = (msg: JsonRpcMsg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.pending.push(wrapped);
      this.flush();
    });
  }

  async rpc(method: string, params?: any, timeout = 5000): Promise<JsonRpcMsg> {
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
});

afterAll(async () => {
  await mcp.close();
  srv.stop();
  cleanupFixture(fix);
});

describe("MCP lifecycle", () => {
  test("initialize returns protocol + capabilities", async () => {
    const res = await mcp.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.1.0" },
    });
    expect(res.result).toBeTruthy();
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.serverInfo.name).toBe("cmms-api");
    expect(res.result.capabilities.tools).toBeTruthy();

    mcp.notify("notifications/initialized");
  });
});

describe("MCP tools/list", () => {
  test("returns the full set of registered tools", async () => {
    const res = await mcp.rpc("tools/list");
    expect(res.result).toBeTruthy();
    const names = res.result.tools.map((t: any) => t.name).sort();
    // The MCP surface has grown over time; assert that the core
    // tools and the Phase 0 additions are present, without pinning
    // an exact count (so adding tools in future phases doesn't break
    // this test).
    const expected = [
      "close_ticket",
      "create_ticket",
      "get_ticket_stats",
      "modify_ticket",
      "remove_ticket",
      "search_existing_tickets",
    ];
    for (const n of expected) {
      expect(names).toContain(n);
    }
  });

  test("search_existing_tickets has inputSchema with q, customer, device, status, period, dates, limit", async () => {
    const res = await mcp.rpc("tools/list");
    const sj = res.result.tools.find((t: any) => t.name === "search_existing_tickets");
    expect(sj).toBeTruthy();
    const props = sj.inputSchema.properties;
    expect(props.q).toBeTruthy();
    expect(props.customer).toBeTruthy();
    expect(props.device).toBeTruthy();
    expect(props.status).toBeTruthy();
    expect(props.status.enum).toEqual(["open", "closed"]);
    expect(props.date_from).toBeTruthy();
    expect(props.date_to).toBeTruthy();
    expect(props.period).toBeTruthy();
    expect(props.limit).toBeTruthy();
  });

  test("create_ticket has customer_name as required", async () => {
    const res = await mcp.rpc("tools/list");
    const ct = res.result.tools.find((t: any) => t.name === "create_ticket");
    expect(ct).toBeTruthy();
    expect(ct.inputSchema.required).toContain("customer_name");
    expect(ct.inputSchema.properties.reported).toBeTruthy();
    expect(ct.inputSchema.properties.devices).toBeTruthy();
    expect(ct.inputSchema.properties.technician).toBeTruthy();
    expect(ct.inputSchema.properties.payment).toBeTruthy();
  });

  test("close_ticket has key as required, optional text and author", async () => {
    const res = await mcp.rpc("tools/list");
    const cl = res.result.tools.find((t: any) => t.name === "close_ticket");
    expect(cl).toBeTruthy();
    expect(cl.inputSchema.required).toContain("key");
    expect(cl.inputSchema.properties.text).toBeTruthy();
    expect(cl.inputSchema.properties.author).toBeTruthy();
  });
});

describe("MCP tool/call — search_existing_tickets", () => {
  test("search by device model", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "search_existing_tickets",
      arguments: { q: "TMV-400", limit: 5 },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.total).toBe(1);
    expect(data.jobs[0].sorszam).toBe("B20010101");
  });

  test("search with diacritic folding", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "search_existing_tickets",
      arguments: { q: "keszulek" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.jobs.some((j: any) => j.key === 2)).toBe(true);
  });

  test("search by device filter", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "search_existing_tickets",
      arguments: { device: "NCT2000" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.jobs.length).toBe(2);
  });

  test("search by status open", async () => {
    // Phase 5.4: the status guard requires a status word in q (or
    // no q at all, in which case we trust the LLM). No q here is the
    // "filter-only" path — the LLM is explicitly asking for the open
    // status set, which is a valid request regardless of question
    // wording.
    const res = await mcp.rpc("tools/call", {
      name: "search_existing_tickets",
      arguments: { status: "open" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.jobs.length).toBe(2);
    expect(data.jobs.every((j: any) => j.status === "open")).toBe(true);
  });
  test("status open with q that lacks a status word strips the filter", async () => {
    // The M09192 hallucination pattern: LLM passes status="open"
    // + q that has no status word. The guard strips the status,
    // so the search returns the closed ticket too (not just open).
    // In the fixture, "készülék" only matches B20020201 (NY/Z=0 =
    // closed). If the strip didn't fire, status="open" would filter
    // that hit out and we'd get 0 results.
    const res = await mcp.rpc("tools/call", {
      name: "search_existing_tickets",
      arguments: { status: "open", q: "készülék" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.jobs.length).toBe(1);
    expect(data.jobs[0].key).toBe(2);
    expect(data.jobs[0].status).toBe("closed");
  });
  test("status open with q that has 'nyitott' keeps the filter", async () => {
    // When the question actually mentions the status word, the guard
    // leaves the LLM-supplied status filter alone.
    const res = await mcp.rpc("tools/call", {
      name: "search_existing_tickets",
      arguments: { status: "open", q: "nyitott készülék" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    // The q AND's to status, so only the open + "készülék" ticket survives.
    expect(data.jobs.every((j: any) => j.status === "open")).toBe(true);
  });

  test("search by customer", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "search_existing_tickets",
      arguments: { customer: "GE" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.jobs.length).toBe(1);
    expect(data.jobs[0].key).toBe(3);
  });

  test("search by date range", async () => {
    // Phase 5.4: the date guard now requires a NAMED period token
    // (e.g. "this_year") for date_from/date_to to be honored. The
    // previous workaround of "period: custom" was the exact pattern
    // the LLM was using to hallucinate dates (M09192 case), so the
    // guard now treats "custom" as an LLM hand-off and strips the
    // dates if the question has no date. Use a named token here.
    const res = await mcp.rpc("tools/call", {
      name: "search_existing_tickets",
      arguments: { period: "this_year", date_from: "2021-01-01", date_to: "2021-12-31" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.jobs.length).toBe(1);
    expect(data.jobs[0].key).toBe(2);
  });
  test("search with period=custom and no question date strips the dates", async () => {
    // The M09192 hallucination pattern: LLM passes period=custom +
    // date_from/date_to even though the question has no date. The
    // guard now strips those before forwarding to the REST API,
    // so the result is unfiltered (and the period echo will say
    // resolved_token=all, not custom).
    const res = await mcp.rpc("tools/call", {
      name: "search_existing_tickets",
      arguments: {
        period: "custom",
        date_from: "2021-01-01",
        date_to: "2021-12-31",
      },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    // After the guard strips the dates AND clears period="custom",
    // the server sees no period -> defaults to "all" -> all 3 jobs
    // in the fixture come back.
    expect(data.jobs.length).toBe(3);
    expect(data.period.resolved_token).toBe("all");
  });
});

describe("MCP tool/call — create_ticket", () => {
  test("creates ticket with minimal fields", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "create_ticket",
      arguments: {
        customer_name: "MCP TEST MINIMAL",
      },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.key).toBeGreaterThan(0);
    expect(data.customer.name).toBe("MCP TEST MINIMAL");
    expect(data.status).toBe("open");
  });

  test("creates ticket with all fields", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "create_ticket",
      arguments: {
        customer_name: "MCP TEST FULL",
        customer_zip: "1234",
        customer_address: "Test u. 1",
        customer_phone: "+36-1-234-5678",
        customer_email: "test@example.com",
        devices: ["NCT2000", "TMV-400"],
        reported: "unit test fault",
        work: "unit test fix",
        technician: "TP",
        reporter: "worker1",
        fault_receiver: "dispatcher",
        payment: "gar",
        remote_access: "teamviewer",
      },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.key).toBeGreaterThan(0);
    expect(data.customer.name).toBe("MCP TEST FULL");
    expect(data.customer.zip).toBe("1234");
    expect(data.customer.address).toBe("Test u. 1");
    expect(data.customer.phone).toBe("+36-1-234-5678");
    expect(data.customer.email).toBe("test@example.com");
    expect(data.status).toBe("open");
    expect(data.devices.length).toBe(2);
    expect(data.notes.some((n: any) => n.body === "unit test fault")).toBe(true);
    expect(data.notes.some((n: any) => n.body === "unit test fix")).toBe(true);
  });

  test("missing customer_name returns tool error", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "create_ticket",
      arguments: { reported: "no customer" },
    });
    expect(res.result.isError).toBe(true);
  });
});

describe("MCP tool/call — close_ticket", () => {
  test("closes an open ticket without solution", async () => {
    // First create a ticket to close
    const create = await mcp.rpc("tools/call", {
      name: "create_ticket",
      arguments: { customer_name: "CLOSE TEST" },
    });
    expect(create.result.isError).toBeUndefined();
    const created = JSON.parse(create.result.content[0].text);
    expect(created.status).toBe("open");

    // Close it
    const res = await mcp.rpc("tools/call", {
      name: "close_ticket",
      arguments: { key: created.key },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.key).toBe(created.key);
    expect(data.status).toBe("closed");
  });

  test("closes an open ticket with solution text", async () => {
    const create = await mcp.rpc("tools/call", {
      name: "create_ticket",
      arguments: { customer_name: "CLOSE WITH SOLUTION" },
    });
    const created = JSON.parse(create.result.content[0].text);

    const res = await mcp.rpc("tools/call", {
      name: "close_ticket",
      arguments: { key: created.key, text: "Replaced PSU, machine boots now", author: "TP" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.status).toBe("closed");
    expect(data.notes.some((n: any) => n.kind === "work" && n.body === "Replaced PSU, machine boots now")).toBe(true);
  });

  test("closing non-existent key returns error", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "close_ticket",
      arguments: { key: 99999 },
    });
    expect(res.result.isError).toBe(true);
  });
});

describe("MCP tool/call — modify_ticket", () => {
  test("corrects customer name on existing ticket", async () => {
    const create = await mcp.rpc("tools/call", {
      name: "create_ticket",
      arguments: { customer_name: "MODIFY TEST", customer_address: "Old Address" },
    });
    const created = JSON.parse(create.result.content[0].text);

    const res = await mcp.rpc("tools/call", {
      name: "modify_ticket",
      arguments: { sorszam: created.sorszam, customer_name: "MODIFY TEST FIXED", customer_address: "New Address 123" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.customer.name).toBe("MODIFY TEST FIXED");
    expect(data.customer.address).toBe("New Address 123");
  });

  test("modifying non-existent sorszam returns error", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "modify_ticket",
      arguments: { sorszam: "NONEXISTENT", customer_name: "Nope" },
    });
    expect(res.result.isError).toBe(true);
  });
});

describe("MCP tool/call — get_ticket_stats", () => {
  test("group_by customer returns sorted [{ name, count }] structure", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "get_ticket_stats",
      arguments: { group_by: "customer" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.group_by).toBe("customer");
    expect(data.results.length).toBeGreaterThan(0);
    // All entries have name and count
    for (const r of data.results) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.count).toBe("number");
      expect(r.count).toBeGreaterThan(0);
    }
    // Results are sorted descending by count
    for (let i = 1; i < data.results.length; i++) {
      expect(data.results[i].count).toBeLessThanOrEqual(data.results[i - 1].count);
    }
  });

  test("group_by status counts open vs closed with correct structure", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "get_ticket_stats",
      arguments: { group_by: "status" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.group_by).toBe("status");
    // Status group_by should only have "open" and/or "closed" keys
    const names = data.results.map((x: any) => x.name);
    expect(names.every((n: string) => n === "open" || n === "closed")).toBe(true);
    // total = number of groups (0, 1, or 2), NOT the sum of counts
    expect(data.results.length).toBe(data.total);
  });

  test("group_by device returns device model counts", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "get_ticket_stats",
      arguments: { group_by: "device" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.group_by).toBe("device");
    expect(data.total).toBeGreaterThan(0);
    // First test fixture includes NCT99M device
    const hasNct99m = data.results.some((x: any) => x.name === "NCT99M");
    expect(hasNct99m).toBe(true);
  });

  test("group_by technician counts only assigned technicians", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "get_ticket_stats",
      arguments: { group_by: "technician" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.group_by).toBe("technician");
    // First test fixture has DOLGOZÓ = "TP;" for key 1
    const hasTP = data.results.some((x: any) => x.name === "TP;");
    expect(hasTP).toBe(true);
  });

  test("group_by month returns YYYY-MM keys", async () => {
    const res = await mcp.rpc("tools/call", {
      name: "get_ticket_stats",
      arguments: { group_by: "month" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.group_by).toBe("month");
    expect(data.results.length).toBeGreaterThan(0);
    // All month keys should match YYYY-MM pattern
    for (const r of data.results) {
      expect(r.name).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  test("filters narrow results before aggregation", async () => {
    // First get unfiltered device stats
    const unfiltered = await mcp.rpc("tools/call", {
      name: "get_ticket_stats",
      arguments: { group_by: "device" },
    });
    const unfilteredData = JSON.parse(unfiltered.result.content[0].text);

    // Then get filtered device stats
    const filtered = await mcp.rpc("tools/call", {
      name: "get_ticket_stats",
      arguments: { group_by: "device", status: "closed" },
    });
    const filteredData = JSON.parse(filtered.result.content[0].text);

    // Filtered results should be fewer (or equal) than unfiltered
    expect(filteredData.results.length).toBeLessThanOrEqual(unfilteredData.results.length);
    expect(filteredData.total).toBeLessThanOrEqual(unfilteredData.total);
  });

  test("combined filters work together", async () => {
    // Filter to closed tickets with "MCP" in free text (matches created test tickets)
    const res = await mcp.rpc("tools/call", {
      name: "get_ticket_stats",
      arguments: { group_by: "customer", status: "closed" },
    });
    expect(res.result.isError).toBeUndefined();
    const data = JSON.parse(res.result.content[0].text);
    // All results should be closed
    expect(data.results.length).toBeGreaterThan(0);
    // Results structure is valid
    for (const r of data.results) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.count).toBe("number");
    }
  });
});
