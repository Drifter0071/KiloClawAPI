// Upload the dashboard-v2 dist to 10.0.3.81.
// The dashboard SPA is served by mcp-server.ts on port 8788, reachable
// through the zrok share at https://nctmechanic.shares.zrok.io/dashboard
// and (after the path map) at /dashboard/v2/.
//
// This script does NOT restart any service. mcp-server.ts serves the
// assets from disk on every request, so reloading the browser tab picks
// up the new bundle.
import { Client } from "ssh2";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const HOST = "10.0.3.81";
const USER = "root";
const PASS = "tarantula999";
const REMOTE_DIR = "/opt/cmms-api/dashboard/v2";
const LOCAL_DIR = "dashboard-v2/dist";

interface SftpFile { name: string; longname: string; attrs: { mode: number; size: number; isDirectory(): boolean; isFile(): boolean; }; }

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

function sftpSession(): Promise<{ conn: Client; sftp: any }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); reject(err); return; }
        resolve({ conn, sftp });
      });
    });
    conn.on("error", (e: Error) => { conn.end(); reject(e); });
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS });
  });
}

function sftpMkdirp(sftp: any, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(dir, { mode: 0o755 }, (err: Error) => {
      // EEXIST is fine
      if (err && !String(err.message).includes("Failure")) { reject(err); return; }
      resolve();
    });
  });
}

function sftpWriteFile(sftp: any, remotePath: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remotePath, { mode: 0o644 });
    ws.on("close", () => resolve());
    ws.on("error", (e: Error) => reject(e));
    ws.end(data);
  });
}

function sftpReaddir(sftp: any, dir: string): Promise<SftpFile[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err: Error, list: SftpFile[]) => {
      if (err) { reject(err); return; }
      resolve(list || []);
    });
  });
}

async function uploadDir(sftp: any, localDir: string, remoteDir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  // Ensure the remote dir exists (mkdir -p is approximated by try/ignore).
  await sftpMkdirp(sftp, remoteDir);
  const entries = readdirSync(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;
    if (entry.isDirectory()) {
      const sub = await uploadDir(sftp, localPath, remotePath);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      const data = readFileSync(localPath);
      await sftpWriteFile(sftp, remotePath, data);
      files += 1;
      bytes += data.length;
    }
  }
  return { files, bytes };
}

async function main() {
  console.log(`\n=== Dashboard-v2 deploy to ${USER}@${HOST} ===\n`);

  console.log("1. Checking local dist...");
  const distStat = statSync(LOCAL_DIR);
  console.log(`   ${LOCAL_DIR} exists (mtime: ${distStat.mtime.toISOString()})`);

  console.log("\n2. Cleaning remote dist (rm -rf)...");
  const rm = await ssh(`rm -rf ${REMOTE_DIR}`);
  if (rm.code !== 0) { console.error("rm failed:", rm.stderr); process.exit(1); }
  console.log("   done.");

  console.log("\n3. Uploading dist via SFTP (recursive)...");
  const { conn, sftp } = await sftpSession();
  try {
    const { files, bytes } = await uploadDir(sftp, LOCAL_DIR, REMOTE_DIR);
    console.log(`   uploaded ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    conn.end();
  }

  console.log("\n4. Verifying index.html is served...");
  const curl = await ssh(`curl -fsS -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:8788/dashboard/v2/ || echo "no-8788" `);
  console.log("   mcp-server.ts 8788:", curl.stdout.trim() || curl.stderr.trim());
  const curl8787 = await ssh(`curl -fsS -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:8787/dashboard/v2/ 2>&1 || echo "no-8787"`);
  console.log("   cmms-api 8787:    ", curl8787.stdout.trim() || curl8787.stderr.trim());

  console.log(`\n=== Done. Reload https://nctmechanic.shares.zrok.io/dashboard/ in the browser. ===\n`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
