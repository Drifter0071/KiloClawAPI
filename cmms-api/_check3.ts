import { Client } from "ssh2";
const c = new Client();
c.on("ready", () => {
  const cmds = [
    "echo '=== context around brand-mark in main ==='",
    "grep -o '..{0,80}brand-mark.*' /opt/cmms-api/dashboard/v2/assets/main-yzsDWcV2.js",
    "echo '=== length of main-yzsDWcV2.js ==='",
    "wc -c /opt/cmms-api/dashboard/v2/assets/main-yzsDWcV2.js",
    "echo '=== hex dump around brand-mark ==='",
    "grep -aPo '.{0,100}brand-mark.{0,100}' /opt/cmms-api/dashboard/v2/assets/main-yzsDWcV2.js",
    "echo '=== is dashboard/v2/brand-mark present? ==='",
    "grep -c 'dashboard/v2/brand-mark' /opt/cmms-api/dashboard/v2/assets/main-yzsDWcV2.js",
    "grep -c 'dashboard/v2/brand-mark' /opt/cmms-api/dashboard/v2/assets/*.js",
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
