const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== zrok share public FULL help ==='",
    "zrok2 share public --help 2>&1",
    "echo '=== zrok config ==='",
    "cat ~/.zrok/zrok.yml 2>/dev/null | head -30 || cat /root/.zrok/zrok.yml 2>/dev/null | head -30 || echo '(no zrok.yml found)'",
    "echo '=== mcp logs 11:05-11:12 ==='",
    "journalctl -u cmms-mcp --since '2026-08-19 11:05:00' --until '2026-08-19 11:12:00' --no-pager | grep -iE 'answer-agent|question|504|timeout|error' | head -30 || echo '(no matching mcp logs)'",
    "echo '=== cmms-api logs 11:05-11:12 (agent activity) ==='",
    "journalctl -u cmms-api --since '2026-08-19 11:05:00' --until '2026-08-19 11:12:00' --no-pager | grep -iE 'digest|answer|agent|fail|error' | head -30 || echo '(no matching api logs)'",
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
