const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== mcp ALL logs 11:00-11:13 ==='",
    "journalctl -u cmms-mcp --since '2026-08-19 11:00:00' --until '2026-08-19 11:13:00' --no-pager | head -60",
    "echo '=== cmms-api ALL logs 11:00-11:13 ==='",
    "journalctl -u cmms-api --since '2026-08-19 11:00:00' --until '2026-08-19 11:13:00' --no-pager | head -60",
    "echo '=== zrok agent logs (journal) ==='",
    "journalctl --since '2026-08-19 10:50:00' --no-pager 2>/dev/null | grep -iE 'zrok' | head -20 || echo '(no zrok journal logs)'",
    "echo '=== who spawned zrok at 11:12? parent chain ==='",
    "ps -ef | grep -E '1913777|1913895' | grep -v grep",
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
