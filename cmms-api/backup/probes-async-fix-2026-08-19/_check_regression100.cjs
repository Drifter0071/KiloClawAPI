// Check regression100 state on the server.
const { Client } = require("ssh2");
const c = new Client();
const cmd =
  "ls -la /tmp/regression100 2>&1; echo ===; " +
  "cat /tmp/regression100/runner.log 2>/dev/null | tail -8; echo ===; " +
  "wc -l /tmp/regression100/results.jsonl 2>/dev/null; echo ===; " +
  "ps -ef | grep -v grep | grep regression100 || echo NO_RUNNER_PROC";
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
