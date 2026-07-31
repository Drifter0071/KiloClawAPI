// Local smoke test for HTTP transport. Spawns the MCP server in HTTP mode,
// hits /mcp with initialize + tools/list, and verifies a session ID comes back.
import { spawn } from "node:child_process";
import { join } from "node:path";

const PORT = 9098;
const BEARER = "test-mcp-bearer";
const child = spawn(
  "bun",
  ["run", join(import.meta.dir, "..", "mcp-server.ts")],
  {
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_PORT: String(PORT),
      MCP_HOST: "127.0.0.1",
      MCP_BEARER_TOKEN: BEARER,
      CMMS_API_URL: "http://127.0.0.1:9099",
      CMMS_API_TOKEN_READ: "fake-read",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

child.stderr.on("data", (d) => process.stderr.write(d));
child.stdout.on("data", (d) => process.stdout.write(d));

// Wait for server to start (look for the listening line on stderr)
await new Promise<void>((resolve) => {
  let buf = "";
  const onData = (d: Buffer) => {
    buf += d.toString();
    if (buf.includes("running on http://")) {
      child.stderr.off("data", onData);
      resolve();
    }
  };
  child.stderr.on("data", onData);
  setTimeout(resolve, 3000);
});

async function mcpPost(body: any, sessionId?: string, withAuth = true): Promise<{
  status: number;
  sessionId: string | null;
  text: string;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (withAuth) headers.Authorization = `Bearer ${BEARER}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), text };
}

// Parse SSE: extract the data: payload (single message).
function sseMessage(text: string): any {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  return null;
}

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name} ${extra}`); fail++; }
}

console.log("HTTP transport smoke test:");

// 1. Without bearer: 401
const noAuth = await mcpPost({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
}, undefined, false);
ok("rejects without bearer", noAuth.status === 401, `got ${noAuth.status}`);

// 2. With bearer: initialize returns serverInfo + session id
const init = await mcpPost({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});
ok("initialize returns 200", init.status === 200, `got ${init.status}`);
const initMsg = sseMessage(init.text);
ok("initialize body has serverInfo", initMsg?.result?.serverInfo?.name === "cmms-api");
ok("initialize has mcp-session-id header", !!init.sessionId, `sessionId=${init.sessionId}`);
const sid = init.sessionId ?? "";

// 3. Use the session: tools/list
const tools = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
ok("tools/list returns 200", tools.status === 200, `got ${tools.status}`);
const toolMsg = sseMessage(tools.text);
const toolNames = (toolMsg?.result?.tools ?? []).map((t: any) => t.name).sort();
ok("tools/list returns 12 tools",
  toolNames.length === 12 && toolNames.includes("close_ticket") && toolNames.includes("create_ticket") && toolNames.includes("get_ticket_stats") && toolNames.includes("modify_ticket") && toolNames.includes("remove_ticket") && toolNames.includes("search_existing_tickets") && toolNames.includes("get_categories") && toolNames.includes("get_tags") && toolNames.includes("add_ticket_tag") && toolNames.includes("set_ticket_category") && toolNames.includes("set_ticket_severity") && toolNames.includes("search_by_category"),
  `got ${JSON.stringify(toolNames)}`);

// 4. Unknown session: 404
const bad = await mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/list" }, "bogus-session-id");
ok("unknown session returns 404", bad.status === 404, `got ${bad.status}`);

// 5. tools/call search_existing_tickets — REST API at 9099 is unreachable, expect isError:true
const call = await mcpPost({
  jsonrpc: "2.0", id: 4, method: "tools/call",
  params: { name: "search_existing_tickets", arguments: { q: "test" } },
}, sid);
ok("tools/call returns 200 envelope", call.status === 200, `got ${call.status}`);
const callMsg = sseMessage(call.text);
ok("tools/call body has isError:true (REST API unreachable)", callMsg?.result?.isError === true);

// 6. DELETE closes the session
const del = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${BEARER}`, "mcp-session-id": sid },
});
ok("DELETE session returns 200", del.status === 200, `got ${del.status}`);

const after = await mcpPost({ jsonrpc: "2.0", id: 5, method: "tools/list" }, sid);
ok("session is gone after DELETE", after.status === 404, `got ${after.status}`);

console.log(`\n${pass} pass, ${fail} fail`);
child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 200));
process.exit(fail === 0 ? 0 : 1);
