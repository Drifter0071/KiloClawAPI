// Upload the cmms-api binary to 10.0.3.81 and restart the cmms-api service.
// Does NOT touch the database — only the binary and the systemd service.
//
// Use this when the change is in src/ but the schema didn't change.
import { Client } from "ssh2";
import { readFileSync, statSync } from "node:fs";

const HOST = "10.0.3.81";
const USER = "root";
const PASS = "tarantula999";
const REMOTE_DIR = "/opt/cmms-api";
const BINARY_LOCAL = "cmms-api-linux";
const BINARY_REMOTE = `${REMOTE_DIR}/cmms-api`;

function ssh(cmd: string, timeout = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { conn.end(); resolve({ code: -1, stdout, stderr: stderr + "\nTIMEOUT" }); }, timeout);
    conn.on("ready", () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); resolve({ code: 1, stdout, stderr: String(err) }); return; }
        stream.on("data", (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        stream.on("close", (code: number) => { clearTimeout(timer); conn.end(); resolve({ code, stdout, stderr }); });
      });
    });
    conn.on("error", (e: Error) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: e.message }); });
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS });
  });
}

function upload(localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); reject(err); return; }
        const data = readFileSync(localPath);
        const ws = sftp.createWriteStream(remotePath, { mode: 0o755 });
        ws.on("close", () => { conn.end(); resolve(); });
        ws.on("error", (e: Error) => { conn.end(); reject(e); });
        ws.end(data);
      });
    });
    conn.on("error", (e: Error) => reject(e));
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS });
  });
}

async function main() {
  console.log(`\n=== Binary-only deploy to ${USER}@${HOST} ===\n`);

  console.log("1. Checking local binary...");
  const size = statSync(BINARY_LOCAL).size;
  console.log(`   ${BINARY_LOCAL} = ${(size / 1024 / 1024).toFixed(1)} MB`);

  console.log("\n2. Uploading binary in 4MB base64 chunks...");
  // SFTP open-write-close on the live binary fails with code 4 (probably
  // because the running service holds the file). So we:
  //   1. stop the service
  //   2. upload to a NEW path via SFTP (worked before in deploy.ts)
  //   3. mv over the live path
  //   4. start the service
  const stop = await ssh("systemctl stop cmms-api.service");
  if (stop.code !== 0) { console.error("stop failed:", stop.stderr); process.exit(1); }

  const data = readFileSync(BINARY_LOCAL);
  const tmpRemote = `${REMOTE_DIR}/cmms-api.new`;
  await new Promise<void>((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); reject(err); return; }
        const ws = sftp.createWriteStream(tmpRemote, { mode: 0o755 });
        ws.on("close", () => { conn.end(); resolve(); });
        ws.on("error", (e: Error) => { conn.end(); reject(e); });
        // Write in 4MB chunks with backpressure handling.
        const CHUNK = 4 * 1024 * 1024;
        let off = 0;
        function pump() {
          while (off < data.length) {
            const end = Math.min(off + CHUNK, data.length);
            if (!ws.write(data.subarray(off, end))) {
              off = end;
              ws.once("drain", pump);
              return;
            }
            off = end;
          }
          ws.end();
        }
        pump();
      });
    });
    conn.on("error", (e: Error) => reject(e));
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS });
  });
  const mv = await ssh(`mv -f ${tmpRemote} ${BINARY_REMOTE} && ls -la ${BINARY_REMOTE}`);
  if (mv.code !== 0) { console.error("mv failed:", mv.stderr); process.exit(1); }
  console.log("   ", mv.stdout.trim());

  console.log("\n3. Starting cmms-api service...");
  const r = await ssh("systemctl start cmms-api.service");
  if (r.code !== 0) { console.error("start failed:", r.stderr); process.exit(1); }
  console.log("   Done.");

  console.log("\n4. Waiting for /v1/health to come back...");
  let ok = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const h = await ssh(`curl -fsS http://127.0.0.1:8787/v1/health 2>/dev/null || echo ""`);
    if (h.stdout.includes('"ok":true')) {
      console.log(`   OK (after ${i + 1} attempt${i + 1 === 1 ? "" : "s"}).`);
      ok = true;
      break;
    }
    process.stdout.write(".");
  }
  if (!ok) {
    console.warn("\n   Service did not come up in time. Checking logs...");
    const logs = await ssh("journalctl -u cmms-api -n 30 --no-pager 2>&1");
    console.log(logs.stdout);
    process.exit(1);
  }

  console.log("\n5. Quick sanity: stats with period...");
  const stats = await ssh(
    `curl -fsS -X POST http://127.0.0.1:8787/v1/jobs/stats ` +
    `-H "Authorization: Bearer $(grep ^CMMS_API_TOKEN_READ= /etc/cmms-api.env | cut -d= -f2)" ` +
    `-H "content-type: application/json" ` +
    `-d '{"group_by":"customer","period":"last_year","limit":2}'`
  );
  console.log("   " + stats.stdout.split("\n").slice(0, 3).join("\n   "));

  console.log("\n=== Binary deploy complete ===\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
