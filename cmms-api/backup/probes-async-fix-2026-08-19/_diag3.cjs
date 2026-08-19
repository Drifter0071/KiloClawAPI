// Re-check cmms-api journal with LOCAL times (server TZ = UTC+2).
const { Client } = require("ssh2");
const c = new Client();
const cmd =
  "journalctl -u cmms-api --since '2026-08-19 16:22:00' --until '2026-08-19 16:30:00' --no-pager 2>&1 | grep -E 'Started|Stopping|etl_start|etl_done|listening' | head -15; " +
  "echo ===PROC===; ps -o pid,lstart,cmd -p $(systemctl show -p MainPID --value cmms-api) 2>/dev/null; " +
  "echo ===PREV===; journalctl -u cmms-api --no-pager 2>&1 | grep etl_start | tail -4";
c.on("ready", () =>
  c.exec(cmd, (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = "";
    stream.on("close", () => { console.log(out); c.end(); });
    stream.on("data", (d) => (out += d.toString()));
  }),
);
c.on("error", (e) => { console.error(e.message); process.exit(1); });
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
