// Check cmms-api journal around the poll + measure direct GET latency.
const { Client } = require("ssh2");
const conn = new Client();
const cmd =
  'journalctl -u cmms-api -n 20 --no-pager 2>&1 | tail -20; echo ===; ' +
  'curl -sS -m 5 -w "\\nGET_HTTP=%{http_code} TIME=%{time_total}s\\n" ' +
  'http://127.0.0.1:8787/v1/answer-agent/async/67e9d1fa-b3f4-483d-8dac-b4b8bacdccba ' +
  '-H "Authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89" | head -c 400';
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
