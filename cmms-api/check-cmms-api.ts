import { Client } from "ssh2";

const HOST = "10.0.3.81";
const USER = "root";
const PASS = "tarantula999";

const c = new Client();
c.on("ready", () => {
  c.exec(
    [
      "echo '=== cmms-api service ==='",
      "systemctl is-active cmms-api",
      "echo '=== last 10 lines of journal ==='",
      "journalctl -u cmms-api -n 10 --no-pager 2>&1 | tail -12",
      "echo '=== curl 8787 ==='",
      "curl -s -o /dev/null -w 'status=%{http_code} time=%{time_total}\\n' http://127.0.0.1:8787/v1/health",
    ].join("; "),
    (err, stream) => {
      let stdout = "";
      stream.on("data", (d: Buffer) => (stdout += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (stdout += d.toString()));
      stream.on("close", () => {
        console.log(stdout);
        c.end();
      });
    },
  );
});
c.on("error", (e) => console.error("err", e.message));
c.connect({ host: HOST, port: 22, username: USER, password: PASS });
