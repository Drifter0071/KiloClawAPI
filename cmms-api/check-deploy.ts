import { Client } from "ssh2";

const HOST = "10.0.3.81";
const USER = "root";
const PASS = "tarantula999";

const c = new Client();
c.on("ready", () => {
  c.exec(
    "echo '=== check 401 root cause ===' && curl -sI http://127.0.0.1:8788/dashboard/v2/brand-mark.png 2>&1 | head -20; echo; echo '=== mcp status ==='; systemctl is-active cmms-mcp; echo; echo '=== listen ==='; ss -tlnp | grep -E '8787|8788'",
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
