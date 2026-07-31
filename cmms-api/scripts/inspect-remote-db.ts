import { Client } from "ssh2";
const c = new Client();
let out = "";
c.on("ready", () => {
  c.exec(
    "ls -la /var/lib/cmms/ 2>&1; echo ===; stat /var/lib/cmms/cmms_specialized.db 2>&1; echo ===; head -c 16 /var/lib/cmms/cmms_specialized.db | od -c | head -2; echo ===; which sqlite3 2>&1; echo ===; sha256sum /var/lib/cmms/cmms_specialized.db 2>&1",
    (err, s) => {
      s.on("data", (d: Buffer) => { out += d.toString(); });
      s.on("close", () => { c.end(); console.log(out); });
    }
  );
});
c.on("error", (e: Error) => console.log("err:", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
