const ssh2 = require("ssh2");
const c = new ssh2.Client();
c.on("ready", () => {
  c.exec("journalctl -u cmms-api -n 300 --no-pager | grep -E 'answer-agent|agent_|agent:' | tail -40; echo '---MCP---'; journalctl -u cmms-mcp -n 200 --no-pager | tail -25", (err, stream) => {
    if (err) { console.error(err); c.end(); return; }
    let out = "";
    stream.on("data", (d) => out += d.toString());
    stream.on("close", () => { console.log(out); c.end(); });
  });
}).on("error", (e) => console.error("err", e.message)).connect({
  host: "10.0.3.81", port: 22, username: "root", password: "tarantula999",
});
