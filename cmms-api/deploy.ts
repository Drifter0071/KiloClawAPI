import { Client } from "ssh2";
import { readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const HOST = "10.0.3.81";
const PORT = 22;
const USER = "root";
const PASS = "tarantula999";
const REMOTE_DIR = "/opt/cmms-api";
const REMOTE_DB = "/var/lib/cmms/cmms.db";

const REPO = import.meta.dir;
const PARENT = join(REPO, "..");

const files: { local: string; remote: string }[] = [
  { local: join(REPO, "cmms-api"), remote: `${REMOTE_DIR}/cmms-api` },
  { local: join(PARENT, "cmms.db"), remote: REMOTE_DB },
  { local: join(REPO, "scripts", "remote-install.sh"), remote: `/tmp/cmms-install.sh` },
  { local: join(REPO, ".env.example"), remote: `${REMOTE_DIR}/.env.example` },
];

function run(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    conn.on("ready", () => {
      conn.exec(cmd, { pty: true }, (err, stream) => {
        if (err) { conn.end(); resolve({ code: 1, stdout, stderr: String(err) }); return; }
        stream.on("data", (d: Buffer) => { stdout += d.toString(); process.stdout.write(d); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); process.stderr.write(d); });
        stream.on("close", (code: number) => { conn.end(); resolve({ code, stdout, stderr }); });
      });
    });
    conn.on("error", (e: Error) => { resolve({ code: 1, stdout, stderr: e.message }); });
    conn.connect({ host: HOST, port: PORT, username: USER, password: PASS });
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
    conn.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  });
}

function runWithPTY(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    conn.on("ready", () => {
      conn.exec("bash", { pty: true }, (err, stream) => {
        if (err) { conn.end(); resolve({ code: 1, stdout, stderr: String(err) }); return; }
        stream.on("data", (d: Buffer) => { stdout += d.toString(); process.stdout.write(d); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); process.stderr.write(d); });
        stream.write(cmd + "\n");
        // send exit after a delay to let commands finish
        setTimeout(() => stream.write("exit\n"), 500);
        stream.on("close", (code: number) => { conn.end(); resolve({ code, stdout, stderr }); });
      });
    });
    conn.on("error", (e: Error) => { resolve({ code: 1, stdout, stderr: e.message }); });
    conn.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  });
}

async function main() {
  console.log(`\n=== Deploying to ${USER}@${HOST} ===\n`);

  // 1. Create remote dirs
  console.log("1. Creating directories...");
  const mkdir = await run(`mkdir -p ${REMOTE_DIR} /var/lib/cmms`);
  if (mkdir.code !== 0) { console.error("mkdir failed:", mkdir.stderr); process.exit(1); }

  // 2. Upload files
  console.log("\n2. Uploading files...");
  for (const f of files) {
    const size = statSync(f.local).size;
    console.log(`   ${basename(f.local)} (${(size / 1024 / 1024).toFixed(1)} MB) -> ${f.remote}`);
    await upload(f.local, f.remote);
  }

  // 3. Run install on remote host
  console.log("\n3. Running install on remote host...");
  const install = await run(`chmod +x ${REMOTE_DIR}/cmms-api /tmp/cmms-install.sh && CMMS_DB_PATH=/var/lib/cmms/cmms.db bash /tmp/cmms-install.sh`);

  if (install.code !== 0) {
    console.error("\nInstall failed. Trying to recover...");
    const check = await run("systemctl status cmms-api 2>&1 | head -20");
    console.log(check.stdout);
  }

  // 4. Wait for tunnel, then get URL
  console.log("\n4. Waiting for tunnel URL...");
  let tunnelUrl = "";
  for (let i = 0; i < 30; i++) {
    const urlCheck = await run(
      `journalctl -u cloudflared-cmms.service --no-pager -n 200 2>/dev/null | grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' | tail -1`
    );
    tunnelUrl = urlCheck.stdout.trim();
    if (tunnelUrl) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  // 5. Verify health
  console.log("\n5. Verifying health...");
  const health = await run(
    `curl -fsS http://127.0.0.1:8787/v1/health 2>/dev/null || echo '{"ok":false}'`
  );
  console.log("Health:", health.stdout.trim());

  // 6. Print summary
  const tokens = await run(`grep CMMS_API_TOKEN_READ ${REMOTE_DIR}/.env 2>/dev/null || grep CMMS_API_TOKEN_READ /etc/cmms-api.env 2>/dev/null`);
  const readToken = tokens.stdout.match(/CMMS_API_TOKEN_READ=(.+)/)?.[1]?.trim() ?? "(check /etc/cmms-api.env)";

  console.log(`
============================================================
DEPLOY COMPLETE
  Host    : ${HOST}
  Binary  : ${REMOTE_DIR}/cmms-api
  cmms.db : ${REMOTE_DB}
  tunnel  : ${tunnelUrl || "(not ready yet — run: journalctl -u cloudflared-cmms -f)"}
  token   : ${readToken}

  kiloclaw needs:
    Base URL: ${tunnelUrl}
    Read token: ${readToken}
============================================================
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
