const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== disable + stop zombie zrok.service ==='",
    "systemctl disable --now zrok 2>&1",
    "echo '=== state after ==='",
    "systemctl is-active zrok; systemctl is-enabled zrok",
    "echo '=== manual share must still be alive ==='",
    "ps -ef | grep 'zrok2 share' | grep -v grep",
    "echo '=== public tunnel health via zrok edge ==='",
    "curl -s -o /dev/null -w 'health: %{http_code} in %{time_total}s\\n' https://nctmechanic.shares.zrok.io/health",
    "echo '=== share process count for agent ==='",
    "ps -o pid,ppid,etime,cmd -p 1913777 2>/dev/null; ps -o pid,ppid,etime,cmd -p 1913895 2>/dev/null",
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
