// One-shot deploy: push the new cmms-api binary + the rebuilt
// cmms_specialized.db (now containing the integrated CSV tables) +
// the CSVs themselves (so the server can rebuild if the file mtimes
// get out of sync) + then push the updated mcp-server.ts and restart
// cmms-mcp. We do NOT touch cloudflared — the remote tunnel is
// managed externally (zrok).
//
//   bun run deploy-integration.ts
//
// Steps:
//   1. Stop cmms-api and cmms-mcp
//   2. Upload binary to /opt/cmms-api/cmms-api
//   3. Upload the new cmms_specialized.db (sidecar; integration tables
//      are inside it, so we replace it). The original cmms.db is NOT
//      touched.
//   4. Upload ./newIntegrationCSVs/*.csv to /opt/cmms-api/csv-integration/
//   5. Upload the updated mcp-server.ts
//   6. Restart cmms-api, wait for health (the auto-ETL loads CSVs on
//      startup)
//   7. Restart cmms-mcp

import { Client } from "ssh2";
import { readFileSync, statSync, createReadStream, existsSync } from "node:fs";
import { readdir, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";

const HOST = "10.0.3.81";
const PORT = 22;
const USER = "root";
const PASS = "tarantula999";
const REMOTE_DIR = "/opt/cmms-api";
const REMOTE_SPEC = "/var/lib/cmms/cmms_specialized.db";
const REMOTE_SPEC_BAK = "/var/lib/cmms/cmms_specialized.db.pre-integration.bak";
const REMOTE_CSV_DIR = "/opt/cmms-api/csv-integration";

const REPO = join(import.meta.dir, "..");
const LOCAL_BINARY = join(REPO, "cmms-api", "cmms-api");
const LOCAL_SPEC = join(REPO, "cmms-api", "cmms_specialized.db");
const LOCAL_CSV_DIR = join(REPO, "newIntegrationCSVs");

function ssh(cmd: string, timeout = 60000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => { conn.end(); resolve({ code: -1, stdout, stderr: stderr + "\nTIMEOUT" }); }, timeout);
    conn.on("ready", () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(t); conn.end(); resolve({ code: 1, stdout, stderr: String(err) }); return; }
        stream.on("data", (d: Buffer) => { stdout += d.toString(); process.stdout.write(d); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); process.stderr.write(d); });
        stream.on("close", (code: number) => { clearTimeout(t); conn.end(); resolve({ code, stdout, stderr }); });
      });
    });
    conn.on("error", (e: Error) => { clearTimeout(t); resolve({ code: 1, stdout, stderr: e.message }); });
    conn.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  });
}

function uploadFile(localPath: string, remotePath: string, mode = 0o644): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const data = readFileSync(localPath);
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); reject(err); return; }
        const ws = sftp.createWriteStream(remotePath, { mode });
        ws.on("close", () => { conn.end(); resolve(); });
        ws.on("error", (e: Error) => { conn.end(); reject(e); });
        ws.end(data);
      });
    });
    conn.on("error", reject);
    conn.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  });
}

async function uploadBinaryViaSftp(localPath: string, remotePath: string): Promise<void> {
  const stat = statSync(localPath);
  console.log(`  uploading ${basename(localPath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  return uploadFile(localPath, remotePath, 0o755);
}

async function main() {
  console.log(`\n=== Deploying cmms-api integration to ${USER}@${HOST} ===\n`);

  // Sanity-check local files exist
  if (!existsSync(LOCAL_BINARY)) { console.error(`binary not found: ${LOCAL_BINARY}`); process.exit(1); }
  if (!existsSync(LOCAL_SPEC))   { console.error(`spec db not found: ${LOCAL_SPEC}`); process.exit(1); }

  // 0. Stop cmms-api
  console.log("0. Stopping cmms-api service...");
  const stop = await ssh("systemctl stop cmms-api.service cmms-mcp.service 2>&1 || true");
  console.log("   stopped.");
  await new Promise(r => setTimeout(r, 2000));

  // 1. Backup the current spec db on the server
  console.log("\n1. Backing up current spec db...");
  const bak = await ssh(`if [ -f ${REMOTE_SPEC} ]; then cp ${REMOTE_SPEC} ${REMOTE_SPEC_BAK} && echo backed_up || echo backup_failed; else echo no_existing; fi`);
  console.log(`   ${bak.stdout.trim()}`);

  // 2. Upload the new binary
  console.log("\n2. Uploading new cmms-api binary...");
  await uploadBinaryViaSftp(LOCAL_BINARY, `${REMOTE_DIR}/cmms-api`);

  // 3. Upload the new spec db (contains the integration tables)
  console.log("\n3. Uploading new cmms_specialized.db...");
  const specSize = statSync(LOCAL_SPEC).size;
  console.log(`  uploading cmms_specialized.db (${(specSize / 1024 / 1024).toFixed(1)} MB)`);
  await uploadFile(LOCAL_SPEC, REMOTE_SPEC, 0o644);
  // fix ownership so cmmsapi user can read it
  await ssh(`chown cmmsapi:cmmsapi ${REMOTE_SPEC} && chmod 0644 ${REMOTE_SPEC}`);

  // 4. Upload the CSVs
  console.log("\n4. Uploading CSV source files...");
  await ssh(`mkdir -p ${REMOTE_CSV_DIR} && chown cmmsapi:cmmsapi ${REMOTE_CSV_DIR}`);
  const csvFiles = await readdir(LOCAL_CSV_DIR);
  for (const f of csvFiles) {
    const local = join(LOCAL_CSV_DIR, f);
    const remote = `${REMOTE_CSV_DIR}/${f}`;
    console.log(`  ${f}`);
    await uploadFile(local, remote, 0o644);
  }
  await ssh(`chown -R cmmsapi:cmmsapi ${REMOTE_CSV_DIR}`);

  // 5. Update the systemd unit's WorkingDirectory is fine (cmmsapi reads CMMS_INTEGRATION_CSV_DIR
  //    from the env). Make sure the env file has it.
  console.log("\n5. Writing CMMS_INTEGRATION_CSV_DIR to /etc/cmms-api.env...");
  const envSet = await ssh(
    `grep -q '^CMMS_INTEGRATION_CSV_DIR=' /etc/cmms-api.env && echo already_set || (echo 'CMMS_INTEGRATION_CSV_DIR=${REMOTE_CSV_DIR}' >> /etc/cmms-api.env && echo appended)`,
  );
  console.log(`   ${envSet.stdout.trim()}`);

  // 6. Start cmms-api
  console.log("\n6. Starting cmms-api service...");
  await ssh(`systemctl daemon-reload && systemctl restart cmms-api.service`);
  console.log("   started, waiting for /v1/health...");

  let healthy = false;
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const h = await ssh("curl -fsS http://127.0.0.1:8787/v1/health 2>/dev/null || echo ''");
    if (h.stdout.includes('"ok"')) {
      console.log(`\n   health: ${h.stdout.trim()}`);
      healthy = true;
      break;
    }
    if (i % 5 === 0) process.stdout.write(".");
  }
  if (!healthy) {
    console.error("\n  cmms-api did not become healthy. Recent logs:");
    const logs = await ssh("journalctl -u cmms-api -n 40 --no-pager 2>&1");
    console.log(logs.stdout);
    process.exit(1);
  }

  // 7. Confirm the integration is loaded
  const integ = await ssh("curl -fsS -H 'authorization: Bearer '\"$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env | cut -d= -f2)\"' http://127.0.0.1:8787/v1/integration/health 2>&1 || echo FAILED");
  console.log("\n7. integration health:");
  console.log(integ.stdout);

  // 8. Push the updated mcp-server.ts and restart cmms-mcp.
  // We don't run deploy-mcp.ts because it would also start a new
  // cloudflared tunnel — the user manages that externally (zrok).
  console.log("\n8. Pushing updated mcp-server.ts and restarting cmms-mcp...");
  const localMcp = join(REPO, "mcp-server.ts");
  if (existsSync(localMcp)) {
    await uploadFile(localMcp, `${REMOTE_DIR}/mcp-server.ts`, 0o644);
    console.log("  uploaded mcp-server.ts");
  } else {
    console.log(`  WARN: ${localMcp} not found, skipping`);
  }
  // Restart cmms-mcp so it picks up the new code.
  await ssh("systemctl restart cmms-mcp.service 2>&1");
  // Wait for MCP HTTP server to come up locally
  let mcpUp = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await ssh(
      `curl -fsS -X POST http://127.0.0.1:8788/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"deploy-check","version":"0.1"}}}' 2>/dev/null || echo ""`,
    );
    if (r.stdout.includes("serverInfo")) {
      console.log(`\n  cmms-mcp is responding.`);
      mcpUp = true;
      break;
    }
    process.stdout.write(".");
  }
  if (!mcpUp) {
    console.warn("\n  cmms-mcp did not respond. Check: journalctl -u cmms-mcp -n 30 --no-pager");
  }

  console.log(`
============================================================
INTEGRATION DEPLOY COMPLETE

  cmms-api binary:  ${REMOTE_DIR}/cmms-api
  spec db:          ${REMOTE_SPEC}  (now includes the integration tables)
  csv dir:          ${REMOTE_CSV_DIR}  (${csvFiles.length} files)
  cmms-mcp:         restarted with new tool count (12 + 6 = 18)

Cloudflare / tunnels are NOT touched (handled externally).
The bearer token for the REST API is in /etc/cmms-api.env.
============================================================
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
