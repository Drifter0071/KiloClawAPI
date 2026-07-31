import { Client } from "ssh2";
const c = new Client();
let out = "";
c.on("ready", () => {
  c.exec("journalctl -u cloudflared-mcp --no-pager -n 200 2>/dev/null | grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' | tail -1", (err, s) => {
    s.on("data", (d: Buffer) => { out += d.toString(); });
    s.on("close", () => { c.end(); console.log("current MCP tunnel URL:", out.trim() || "(none)"); });
  });
});
c.on("error", (e: Error) => console.log("err:", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
