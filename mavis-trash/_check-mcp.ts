import { Client } from "ssh2";

const c = new Client();
const sid = "test-" + Date.now();
const headers = `Authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89
Content-Type: application/json
Accept: application/json, text/event-stream`;

function call(method: string, params: any): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

const initCmd = `curl -s -i -X POST http://127.0.0.1:8788/mcp \
  -H "${headers.replace(/\n/g, '\" -H \"')}" \
  -d ${JSON.stringify(call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } }))} | grep -i 'mcp-session-id' | head -1`;

c.on("ready", () => {
  c.exec(initCmd, (err, stream) => {
    if (err) { console.error(err); c.end(); return; }
    let buf = "";
    stream.on("data", d => buf += d);
    stream.on("end", () => {
      const m = buf.match(/mcp-session-id:\s*(\S+)/i);
      if (!m) {
        console.log("no session id. raw:", buf);
        c.end();
        return;
      }
      const session = m[1].replace(/[\r\n]/g, "");
      console.log("session:", session.slice(0, 16) + "...");

      // Now do tools/list with the session
      const listCmd = `curl -s -X POST http://127.0.0.1:8788/mcp \
        -H "${headers.replace(/\n/g, '\" -H \"')}" \
        -H "mcp-session-id: ${session}" \
        -d ${JSON.stringify(call("tools/list", {}))}`;
      c.exec(listCmd, (err2, stream2) => {
        if (err2) { console.error(err2); c.end(); return; }
        let buf2 = "";
        stream2.on("data", d => buf2 += d);
        stream2.on("end", () => {
          const line = buf2.split("\n").find(l => l.startsWith("data: "));
          if (line) {
            const j = JSON.parse(line.slice(6));
            const names = (j.result?.tools || []).map(t => t.name).sort();
            console.log("tool count:", names.length);
            console.log("has find_linkage:", names.includes("find_linkage"));
            console.log("has find_related_tickets:", names.includes("find_related_tickets"));
            console.log("has search_existing_tickets:", names.includes("search_existing_tickets"));
            console.log("has answer_question:", names.includes("answer_question"));
            console.log("all tools:", names.join(", "));
          } else {
            console.log("RAW:", buf2.slice(0, 500));
          }
          c.end();
        });
      });
    });
  });
});
c.on("error", e => console.error("conn err", e));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999", readyTimeout: 15000 });
