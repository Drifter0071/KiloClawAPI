const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== run-zrok.sh CONTENTS ==='",
    "cat /usr/local/bin/run-zrok.sh",
    "echo '=== manual agent parent chain ==='",
    "ps -o pid,ppid,cmd -p 1913750,1913777,1913895 2>/dev/null",
    "echo '=== dashboard/api + answer-agent mcp log entries today ==='",
    "journalctl -u cmms-mcp --since '2026-08-19 09:00' --no-pager | grep -E 'dashboard/api|answer-agent' | tail -20",
    "echo '=== zrok.service first start + enabled state ==='",
    "systemctl is-enabled zrok; systemctl show zrok -p NRestarts --no-pager",
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
