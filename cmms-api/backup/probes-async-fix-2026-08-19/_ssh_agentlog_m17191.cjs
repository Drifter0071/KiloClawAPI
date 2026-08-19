// Check cmms-api logs for agent runs: soft deadline forces, failures, and durations.
const { Client } = require("ssh2");
const conn = new Client();
const cmd = [
  "journalctl -u cmms-api --since '2026-08-19 11:30' --no-pager |",
  "grep -E 'agent_soft_deadline_forced|agent_failed|agent_answer_digest|unhandled_error|no such column' |",
  "tail -n 40",
].join(" ");
conn.on("ready", () => {
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error("EXEC ERR", err.message); conn.end(); return; }
    let out = "";
    stream.on("close", () => { console.log(out.slice(0, 8000)); conn.end(); });
    stream.on("data", (d) => { out += d.toString(); });
  });
}).connect({ host: "10.0.3.81", username: "root", password: "tarantula999" });
