// Check mcp-server env + reachability of cmms-api from the mcp server.
const { Client } = require("ssh2");
const conn = new Client();
const cmd =
  'grep -E "^(CMMS_API_URL|CMMS_API_TOKEN_READ)" /opt/cmms-api/mcp-cmms.env 2>/dev/null; ' +
  'echo ---; curl -fsS -m 5 http://127.0.0.1:8787/v1/health 2>&1 | head -c 300; echo; ' +
  'echo ---; curl -sS -m 5 http://127.0.0.1:8788/dashboard/api/answer-agent 2>&1 | head -c 200; echo; ' +
  'echo ---; systemctl is-active cmms-api cmms-mcp';
conn.on("ready", () =>
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = "";
    stream.on("close", () => { console.log(out); conn.end(); });
    stream.on("data", (d) => (out += d.toString()));
  }),
);
conn.on("error", (e) => { console.error(e.message); process.exit(1); });
conn.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
