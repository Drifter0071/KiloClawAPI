const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== cmms-api status ==='",
    "systemctl is-active cmms-api; systemctl is-active cmms-mcp",
    "echo '=== zrok share ==='",
    "ps -ef | grep 'zrok2 share' | grep -v grep | head -3",
    "echo '=== latest cmms-api logs ==='",
    "journalctl -u cmms-api -n 60 --no-pager | tail -40",
    "echo '=== agent digest count today ==='",
    "journalctl -u cmms-api --since '2026-08-19 00:00' --no-pager | grep -c 'agent_answer_digest' || true",
    "journalctl -u cmms-api --since '2026-08-19 09:00' --no-pager | grep -E 'digest|agent|fail' | tail -25 || true",
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
