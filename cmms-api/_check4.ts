import { Client } from "ssh2";
const c = new Client();
c.on("ready", () => {
  c.exec(
    [
      "systemctl is-active cmms-api",
      "journalctl -u cmms-api -n 15 --no-pager 2>&1 | tail -20",
      "ss -tlnp | grep -E '8787|8788'",
      "curl -s -w 'status=%{http_code} time=%{time_total}' -o /dev/null http://127.0.0.1:8787/v1/health",
      "curl -s -w 'status=%{http_code} time=%{time_total}' -o /dev/null http://127.0.0.1:8788/v1/health",
    ].join("; "),
    (err, stream) => {
      let out = "";
      stream.on("data", (d: Buffer) => (out += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (out += d.toString()));
      stream.on("close", () => { console.log(out); c.end(); });
    },
  );
});
c.on("error", (e) => console.error("err", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
