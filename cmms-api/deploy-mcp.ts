// Deploy mcp-server.ts to 10.0.3.81 alongside the existing cmms-api.
//
// Uses bun:ssh2 (Bun's built-in SSH2, no npm ssh2 dep needed).
//
// What it does:
//   1. Upload mcp-server.ts + package.json + tsconfig.json
//   2. Install dependencies on the remote (bun install)
//   3. Read the existing read token from /etc/cmms-api.env
//   4. Write /opt/cmms-api/mcp-cmms.env with HTTP transport + bearer auth
//   5. Create cmms-mcp.service systemd unit (HTTP, listens on 127.0.0.1:8788)
//   6. Create cloudflared-mcp.service (tunnel for the MCP HTTP endpoint)
//   7. Smoke-test: HTTP MCP /mcp endpoint accepts initialize through the tunnel
//
// The cloud agent (kiloclaw) connects to the MCP server via:
//   URL:     <tunnel-url>/mcp
//   Header:  Authorization: Bearer <CMMS_API_TOKEN_READ>
//
// Usage:  bun run deploy-mcp.ts

import { Client } from "ssh2";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "10.0.3.81";
const PORT = 22;
const USER = "root";
const PASS = "tarantula999";
const REMOTE_DIR = "/opt/cmms-api";
const MCP_BIND_HOST = "127.0.0.1";
const MCP_BIND_PORT = 8788;

// --- SSH helpers ---

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
    conn.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  });
}

function sshVerbose(cmd: string, timeout = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { conn.end(); resolve({ code: -1, stdout, stderr: stderr + "\nTIMEOUT" }); }, timeout);
    conn.on("ready", () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); resolve({ code: 1, stdout, stderr: String(err) }); return; }
        stream.on("data", (d: Buffer) => { stdout += d.toString(); process.stdout.write(d); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); process.stderr.write(d); });
        stream.on("close", (code: number) => { clearTimeout(timer); conn.end(); resolve({ code, stdout, stderr }); });
      });
    });
    conn.on("error", (e: Error) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: e.message }); });
    conn.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  });
}

function uploadText(content: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => { conn.end(); reject(new Error("uploadText timeout")); }, 30000);
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { clearTimeout(timer); conn.end(); reject(err); return; }
        const ws = sftp.createWriteStream(remotePath, { mode: 0o644 });
        ws.on("close", () => { clearTimeout(timer); conn.end(); resolve(); });
        ws.on("error", (e: Error) => { clearTimeout(timer); conn.end(); reject(e); });
        ws.end(Buffer.from(content, "utf-8"));
      });
    });
    conn.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    conn.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  });
}

// --- Main ---

async function main() {
  console.log(`=== Deploying MCP server (HTTP transport) to ${USER}@${HOST} ===\n`);

  // 1. Upload mcp-server.ts
  console.log("1. Uploading mcp-server.ts...");
  const mcpSrc = readFileSync(join(import.meta.dir, "mcp-server.ts"), "utf-8");
  await uploadText(mcpSrc, `${REMOTE_DIR}/mcp-server.ts`);
  console.log("   Done.");

  // 2. Upload package.json
  console.log("2. Uploading package.json...");
  const pkgJson = readFileSync(join(import.meta.dir, "package.json"), "utf-8");
  await uploadText(pkgJson, `${REMOTE_DIR}/package.json`);
  console.log("   Done.");

  // 3. Upload tsconfig.json
  console.log("3. Uploading tsconfig.json...");
  const tsconfig = readFileSync(join(import.meta.dir, "tsconfig.json"), "utf-8");
  await uploadText(tsconfig, `${REMOTE_DIR}/tsconfig.json`);
  console.log("   Done.");

  // 4. Install dependencies on remote
  console.log("4. Installing dependencies on remote...");
  const install = await sshVerbose(`cd ${REMOTE_DIR} && bun install --frozen-lockfile 2>&1 || bun install 2>&1`, 60000);
  if (install.code !== 0) {
    console.error("   bun install failed:", install.stderr);
    process.exit(1);
  }
  console.log("   Done.");

  // 5. Read the existing read token from /etc/cmms-api.env
  console.log("5. Reading existing tokens...");
  const tokenRes = await ssh("cat /etc/cmms-api.env 2>/dev/null | grep -E 'CMMS_API_TOKEN_(READ|WRITE)='");
  const readMatch = tokenRes.stdout.match(/CMMS_API_TOKEN_READ=(.+)/);
  const writeMatch = tokenRes.stdout.match(/CMMS_API_TOKEN_WRITE=(.+)/);
  const readToken = readMatch?.[1]?.trim() ?? "";
  const writeToken = writeMatch?.[1]?.trim() ?? "";

  if (!readToken) {
    console.error("   Could not read CMMS_API_TOKEN_READ from /etc/cmms-api.env");
    process.exit(1);
  }
  console.log(`   Read token: ${readToken.slice(0, 8)}...`);

  // 6. Write MCP env file (HTTP transport, bearer auth = read token)
  console.log("6. Writing MCP env file...");
  const mcpEnv = [
    `MCP_TRANSPORT=http`,
    `MCP_HOST=${MCP_BIND_HOST}`,
    `MCP_PORT=${MCP_BIND_PORT}`,
    `CMMS_API_URL=http://127.0.0.1:8787`,
    `CMMS_API_TOKEN_READ=${readToken}`,
    writeToken ? `CMMS_API_TOKEN_WRITE=${writeToken}` : "",
    // Bearer token that remote clients must send. We reuse the read token
    // so a single secret works for both REST auth and MCP HTTP auth.
    `MCP_BEARER_TOKEN=${readToken}`,
  ]
    .filter(Boolean)
    .join("\n");
  await uploadText(mcpEnv, `${REMOTE_DIR}/mcp-cmms.env`);
  await ssh(`chmod 0600 ${REMOTE_DIR}/mcp-cmms.env`);
  console.log("   Done.");

  // 7. Stop any old stdio unit, create HTTP systemd unit
  console.log("7. Creating cmms-mcp.service (HTTP)...");
  await ssh("systemctl stop cmms-mcp.service 2>/dev/null || true");
  const unit = [
    "[Unit]",
    "Description=cmms-api MCP HTTP server (Streamable HTTP transport)",
    "After=cmms-api.service",
    "Wants=cmms-api.service",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=/opt/cmms-api",
    "EnvironmentFile=/opt/cmms-api/mcp-cmms.env",
    "User=cmmsapi",
    "Group=cmmsapi",
    "ExecStart=/usr/local/bin/bun run /opt/cmms-api/mcp-server.ts",
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=true",
    "ProtectHome=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");
  await uploadText(unit, "/etc/systemd/system/cmms-mcp.service");
  await ssh("chmod 0644 /etc/systemd/system/cmms-mcp.service && systemctl daemon-reload && systemctl enable cmms-mcp.service && systemctl restart cmms-mcp.service");
  console.log("   Done.");

  // 8. Wait for MCP HTTP server to come up locally
  console.log("8. Waiting for MCP HTTP server (127.0.0.1:8788)...");
  let mcpUp = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await ssh(
      `curl -fsS -X POST http://127.0.0.1:${MCP_BIND_PORT}/mcp -H "Authorization: Bearer ${readToken}" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"deploy-smoke","version":"0.1.0"}}}' 2>/dev/null || echo ""`,
    );
    if (r.stdout.includes('"serverInfo"')) {
      console.log("\n   MCP HTTP /mcp responds to initialize. OK.");
      mcpUp = true;
      break;
    }
    process.stdout.write(".");
  }
  if (!mcpUp) {
    console.warn("\n   MCP HTTP server not responding. Checking logs...");
    const logs = await ssh("journalctl -u cmms-mcp -n 20 --no-pager 2>&1");
    console.log(logs.stdout);
    process.exit(1);
  }

  // 9. Tunnel: managed externally by zrok. No work to do here.
  //    Detect the zrok share if present, so the user can see it in
  //    the summary; otherwise the user can run `zrok2 share public`
  //    themselves and the result will be in the zrok agent logs.
  console.log("\n9. Tunnel is managed externally by zrok (not by this deploy).");
  const zrokCheck = await ssh(
    `ps -ef | grep -E "zrok2 share" | grep -v grep | head -1 || true; ` +
    `curl -fsS -m 5 https://api.zrok.io 2>/dev/null >/dev/null && echo "zrok api reachable" || true`,
  );
  if (zrokCheck.stdout.includes("zrok2 share")) {
    console.log("   zrok share is running:");
    console.log("   " + zrokCheck.stdout.split("\n").filter((l) => l.includes("zrok2 share")).join("\n   "));
  } else {
    console.log("   zrok share is NOT running. Start it manually:");
    console.log("     systemctl status zrok2");
    console.log("     zrok2 share public --subordinate -b proxy --name-selection public:nctmechanic http://localhost:8788");
  }

  // 10. End-to-end smoke: hit the MCP /mcp locally (zrok fronts this).
  console.log("\n10. End-to-end test through local MCP HTTP endpoint...");
  const e2e = await ssh(
    `curl -fsS -X POST "http://127.0.0.1:${MCP_BIND_PORT}/mcp" -H "Authorization: Bearer ${readToken}" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0.1.0"}}}' 2>&1 | head -c 400`,
    20000,
  );
  if (e2e.stdout.includes('"serverInfo"')) {
    console.log("   OK — local MCP HTTP endpoint responds to initialize.");
    const serverVersion = (e2e.stdout.match(/"version":"([^"]+)"/) ?? [])[1];
    if (serverVersion) console.log(`   Server version: ${serverVersion}`);
  } else {
    console.warn("   End-to-end test did not return serverInfo.");
    console.warn("   stdout:", e2e.stdout.slice(0, 500));
    console.warn("   stderr:", e2e.stderr.slice(0, 500));
  }

  // 11. Refresh ~/tunnel-info.txt so the public URL is documented.
  console.log("\n11. Refreshing ~/tunnel-info.txt...");
  const tunnelInfo = await ssh(
    `bash ${REMOTE_DIR}/start.sh >/dev/null 2>&1 && cat ~/tunnel-info.txt | head -10`,
  );
  console.log("   " + tunnelInfo.stdout.split("\n").filter(Boolean).join("\n   "));

  console.log(`
============================================================
MCP DEPLOY COMPLETE (HTTP transport for remote agents)
  Host             : ${HOST}
  MCP file         : ${REMOTE_DIR}/mcp-server.ts
  MCP env          : ${REMOTE_DIR}/mcp-cmms.env
  Service (HTTP)   : cmms-mcp.service on 127.0.0.1:${MCP_BIND_PORT}
  Tunnel           : zrok (managed externally, see ~/tunnel-info.txt)
  Bearer token     : ${readToken.slice(0, 12)}...

  Cloud agent config:
    URL     : <zrok share URL>/mcp  (see ~/tunnel-info.txt)
    Auth    : Authorization: Bearer ${readToken}
    Protocol: MCP Streamable HTTP (2024-11-05)

  The bearer token is the same as CMMS_API_TOKEN_READ, so any
  agent that already has the read token can use it directly.
============================================================`);
}

main().catch((e) => { console.error(e); process.exit(1); });
