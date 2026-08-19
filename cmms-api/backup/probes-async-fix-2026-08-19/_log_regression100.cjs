// Pull + analyze regression100 results.
const { Client } = require("ssh2");
const fs = require("fs");
const c = new Client();
const cmd = "cat /tmp/regression100/runner.log | head -12; echo ===TAIL===; cat /tmp/regression100/runner.log | tail -12; echo ===SUMMARY===; cat /tmp/regression100/summary.json 2>/dev/null";
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
