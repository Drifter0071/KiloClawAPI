import { Client } from "ssh2";
const c = new Client();
c.on("ready", () => {
  const cmds = [
    "echo '=== NctMark section in main ==='",
    "grep -o '.{0,50}brand-mark.{0,50}' /opt/cmms-api/dashboard/v2/assets/main-yzsDWcV2.js",
    "echo '=== AskPage answer_id ==='",
    "grep -o '.{0,30}answer_id.{0,30}' /opt/cmms-api/dashboard/v2/assets/AskPage-Bk3mm0Zx.js | head -5",
    "echo '=== main feedback/vote ==='",
    "grep -o '.{0,40}feedback/vote.{0,40}' /opt/cmms-api/dashboard/v2/assets/main-yzsDWcV2.js",
    "echo '=== all assets with brand-mark ==='",
    "grep -rl 'brand-mark' /opt/cmms-api/dashboard/v2/assets/ 2>/dev/null",
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
