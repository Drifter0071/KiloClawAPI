const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  const cmd = [
    "echo '=== mcp local health ==='",
    "curl -s -m 5 http://127.0.0.1:8788/health; echo",
    "echo '=== dashboard answer-agent via local proxy (30s cap) ==='",
    "time curl -s -m 30 -X POST http://127.0.0.1:8788/dashboard/api/answer-agent -H 'content-type: application/json' -d '{\"q\":\"Hány nyitott ticketje van az ANDRITZ Kft.-nek?\",\"language\":\"hu\"}' | head -c 200; echo",
    "echo '=== zrok public URL health ==='",
    "curl -s -m 8 https://nctmechanic.shares.zrok.io/health; echo",
    "echo '=== zrok public answer-agent (45s cap) ==='",
    "time curl -s -m 45 -X POST https://nctmechanic.shares.zrok.io/dashboard/api/answer-agent -H 'content-type: application/json' -d '{\"q\":\"Melyik vezérlő okozza a legtöbb hibát?\",\"language\":\"hu\"}' | head -c 200; echo",
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
