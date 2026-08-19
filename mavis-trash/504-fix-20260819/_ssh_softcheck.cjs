const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "journalctl -u cmms-api --since '2026-08-19 11:48' --no-pager | grep -E 'soft_deadline|agent_failed|unhandled_error' | tail -25",
    "echo '=== count of soft_deadline_forced today ==='",
    "journalctl -u cmms-api --since '2026-08-19 00:00' --no-pager | grep -c agent_soft_deadline_forced || true",
  ].join("\n");
  c.exec(cmd, (err, stream) => {
    if (err) { console.error(err); c.end(); return; }
    let out = "";
    stream.on("data", (d) => out += d.toString());
    stream.on("close", () => { console.log(out); c.end(); });
  });
}).on("error", (e) => console.error("err", e.message)).connect({
  host: "10.0.3.81", port: 22, username: "root", password: "tarantula999",
});
