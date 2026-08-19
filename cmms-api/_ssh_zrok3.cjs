const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== zrok.service unit ==='",
    "cat /etc/systemd/system/zrok.service 2>/dev/null || systemctl cat zrok.service 2>/dev/null || echo '(no unit file found)'",
    "echo '=== run-zrok.sh ==='",
    "cat /opt/cmms-api/run-zrok.sh 2>/dev/null || find / -name 'run-zrok.sh' -not -path '*/proc/*' 2>/dev/null | head -3",
    "echo '=== restart counter + uptime ==='",
    "systemctl status zrok --no-pager | head -12",
    "echo '=== crash loop since? (first conflict in today journal) ==='",
    "journalctl -u zrok --since '2026-08-19 00:00' --no-pager | grep -m1 shareConflict; journalctl -u zrok --since '2026-08-19 00:00' --no-pager | grep -c shareConflict",
    "echo '=== mcp logs: does dashboard API logging exist? (grep api/answer) ==='",
    "journalctl -u cmms-mcp --since '2026-08-19 09:00' --no-pager | grep -cE 'dashboard/api|answer-agent' || true",
    "echo '=== agent.ts log keys (local source grep via server binary strings is heavy; just list journal msgs) ==='",
    "journalctl -u cmms-api --since '2026-08-19 09:00' --no-pager | grep -oE '\"msg\":\"[^\"]+\"' | sort | uniq -c | sort -rn | head -20",
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
