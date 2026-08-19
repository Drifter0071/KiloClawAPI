// Upload regression100 files to the server and start the runner with nohup.
const { Client } = require("ssh2");
const fs = require("fs");

const HOST = "10.0.3.81";
const USER = "root";
const PASS = "tarantula999";
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
  await exec(c, `mkdir -p ${REMOTE_DIR}`);
  await upload(c, LOCAL + "/regression100-questions.json", REMOTE_DIR + "/questions.json");
  await upload(c, LOCAL + "/regression100-runner.cjs", REMOTE_DIR + "/regression100-runner.cjs");
  console.log("uploaded questions.json + runner");

  // Check bun availability + start with nohup
  const bunPath = await exec(c, "command -v bun || echo NO_BUN");
  console.log("bun:", bunPath.trim());
  const start = await exec(
    c,
    `cd ${REMOTE_DIR} && nohup /root/.bun/bin/bun regression100-runner.cjs > runner.out 2>&1 & echo STARTED_PID=$!`
  );
  console.log(start.trim());
  await new Promise((res) => setTimeout(res, 4000));
  const peek = await exec(c, `cat ${REMOTE_DIR}/runner.log 2>/dev/null | tail -5; echo ---; ls -la ${REMOTE_DIR}`);
  console.log(peek);
  c.end();
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
