// Check cmms-api restarts in the window + current KILO_MODEL.
const { Client } = require("ssh2");
const c = new Client();
const cmd =
  "journalctl -u cmms-api --since '2026-08-19 14:23:00' --until '2026-08-19 14:28:30' --no-pager 2>&1 | head -25; " +
  "echo ===MODEL===; grep -E '^(KILO_MODEL|ASK_AGENT_V2)=' /etc/cmms-api.env; " +
  "echo ===RUNNER===; tail -4 /tmp/regression100/runner.log; wc -l /tmp/regression100/results.jsonl";
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
