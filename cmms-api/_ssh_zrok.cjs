const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== zrok help timeout ==='",
    "zrok2 share public --help 2>&1 | grep -iE 'timeout|idle|keepalive' || echo '(no timeout flags in help)'",
    "echo '=== tunnel-info.txt ==='",
    "cat ~/tunnel-info.txt 2>/dev/null || echo '(missing)'",
    "echo '=== all zrok processes (full cmd) ==='",
    "ps -ef | grep zrok2 | grep -v grep",
    "echo '=== start.sh zrok section ==='",
    "grep -n -A6 'zrok' /opt/cmms-api/start.sh 2>/dev/null | head -40 || echo '(no start.sh)'",
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
