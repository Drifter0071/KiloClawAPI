import { Client } from "ssh2";
const c = new Client();
let out = "";
c.on("ready", () => {
  c.exec(
    "systemctl is-active cmms-api cmms-mcp 2>&1; echo ---; journalctl -u cmms-api -n 30 --no-pager 2>&1",
    (err, s) => {
      s.on("data", (d: Buffer) => { out += d.toString(); });
      s.on("close", () => { c.end(); console.log(out); });
    }
  );
});
c.on("error", (e: Error) => console.log("err:", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
