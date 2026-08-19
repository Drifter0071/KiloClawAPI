const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== unhandled_errors on new binary (since 11:58) ==='",
    "journalctl -u cmms-api --since '2026-08-19 11:58' --no-pager | grep -E 'unhandled_error|agent_failed|soft_deadline' | tail -10 || echo '(none)'",
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
