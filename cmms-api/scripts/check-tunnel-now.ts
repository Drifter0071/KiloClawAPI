import { Client } from "ssh2";
const c = new Client();
let out = "";
c.on("ready", () => {
  c.exec(
    "systemctl list-units --type=service --all 2>/dev/null | grep -iE 'cloudflared|zrok|tunnel|mcp' 2>&1; echo ---; ls /etc/systemd/system/ 2>&1 | grep -iE 'cloudflared|zrok|tunnel|mcp' 2>&1; echo ---; ss -tlnp 2>/dev/null | grep -E ':(8787|8788|8443)' || netstat -tlnp 2>/dev/null | grep -E ':(8787|8788|8443)'",
    (err, s) => {
      s.on("data", (d: Buffer) => { out += d.toString(); });
      s.on("close", () => { c.end(); console.log(out); });
    }
  );
});
c.on("error", (e: Error) => console.log("err:", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
