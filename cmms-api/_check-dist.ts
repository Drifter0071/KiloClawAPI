import { Client } from "ssh2";
const c = new Client();
c.on("ready", () => {
  const cmds = [
    "echo '=== brand-mark.png ==='",
    "ls -la /opt/cmms-api/dashboard/v2/brand-mark.png 2>&1",
    "echo '=== AskPage js ==='",
    "ls -la /opt/cmms-api/dashboard/v2/assets/AskPage-*.js 2>&1",
    "echo '=== answer_id in AskPage? ==='",
    "grep -c 'answer_id' /opt/cmms-api/dashboard/v2/assets/AskPage-*.js 2>&1",
    "echo '=== feedback/vote in any js? ==='",
    "grep -l 'feedback/vote' /opt/cmms-api/dashboard/v2/assets/*.js 2>&1 || echo NONE",
    "echo '=== brand-mark path in NctMark? ==='",
    "grep -rl 'brand-mark' /opt/cmms-api/dashboard/v2/assets/*.js 2>&1 | head -5",
    "echo '=== brand-mark.png url in deployed js ==='",
    "grep -o '\"/brand-mark[^\"]*\"' /opt/cmms-api/dashboard/v2/assets/*.js 2>&1 | head -10",
    "echo '=== NctMark references ==='",
    "grep -o 'brand-mark.png' /opt/cmms-api/dashboard/v2/assets/*.js 2>&1 | head -10",
    "echo '=== index.html first line ==='",
    "head -c 300 /opt/cmms-api/dashboard/v2/index.html",
    "echo '=== file count ==='",
    "find /opt/cmms-api/dashboard/v2 -type f | wc -l",
  ];
  c.exec(cmds.join("; "), (err, stream) => {
    let out = "";
    stream.on("data", (d: Buffer) => (out += d.toString()));
    stream.stderr.on("data", (d: Buffer) => (out += d.toString()));
    stream.on("close", () => { console.log(out); c.end(); });
  });
});
c.on("error", (e) => console.error("err", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
