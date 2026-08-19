// Wait for pass-1 to finish, then upload + start the retry pass.
const { Client } = require("ssh2");
const fs = require("fs");
const HOST = "10.0.3.81", USER = "root", PASS = "tarantula999";
const LOCAL = "C:/Users/garvanger/Documents/GitHub/KiloClawAPI/cmms-api/backup/probes-async-fix-2026-08-19";
const REMOTE_DIR = "/tmp/regression100";

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host: HOST, port: 22, username: USER, password: PASS });
  });
}
function exec(c, cmd) {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("close", () => resolve(out));
      stream.on("data", (d) => (out += d.toString()));
    });
  });
}
function upload(c, local, remote) {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, (e) => (e ? reject(e) : resolve()));
    });
  });
}

async function main() {
  const c = await connect();
  // Wait until pass-1 summary.json exists (runner finished)
  for (let i = 0; i < 40; i++) {
    const s = await exec(c, `cat ${REMOTE_DIR}/summary.json 2>/dev/null || echo NONE`);
    if (!s.includes("NONE")) { console.log("pass1 finished:", s.trim()); break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  // Make sure no runner process is still alive
  await exec(c, `pkill -f regression100-runner.cjs 2>/dev/null; sleep 1; echo killed-stale`);
  await upload(c, LOCAL + "/regression100-retry.cjs", REMOTE_DIR + "/regression100-retry.cjs");
  console.log("retry runner uploaded");
  const start = await exec(
    c,
    `cd ${REMOTE_DIR} && nohup /root/.bun/bin/bun regression100-retry.cjs > retry.out 2>&1 & echo STARTED_PID=$!`
  );
  console.log(start.trim());
  await new Promise((res) => setTimeout(res, 5000));
  const peek = await exec(c, `tail -4 ${REMOTE_DIR}/retry.log 2>/dev/null; wc -l ${REMOTE_DIR}/results-retry.jsonl 2>/dev/null`);
  console.log(peek);
  c.end();
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
