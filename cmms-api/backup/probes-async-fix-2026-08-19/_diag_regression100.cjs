// Check cmms-api journal around 14:25-14:28Z + first result error text.
const { Client } = require("ssh2");
const c = new Client();
const cmd =
  "journalctl -u cmms-api --since '2026-08-19 14:22:00' --until '2026-08-19 14:29:00' --no-pager 2>&1 | grep -E 'Started|Stopping|etl_start|etl_done|listening' | head -12; " +
  "echo ===ERR1===; head -3 /tmp/regression100/results.jsonl; " +
  "echo ===ERR88===; sed -n '88p' /tmp/regression100/results.jsonl";
c.on("ready", () =>
  c.exec(cmd, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = "";
    stream.on("close", () => { console.log(out); c.end(); });
    stream.on("data", (d) => (out += d.toString()));
  }),
);
c.on("error", (e) => { console.error(e.message); process.exit(1); });
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
