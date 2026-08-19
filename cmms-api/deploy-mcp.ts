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
import { readFileSync, readdirSync, existsSync } from "node:fs";
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
  return uploadBinary(Buffer.from(content, "utf-8"), remotePath);
}

// Binary-safe upload. Reads and writes raw bytes — required for
// images (PNG, ICO, JPG), fonts (WOFF, WOFF2), and any other file
// whose bytes are not valid UTF-8. The previous uploadText-only
// path corrupted WOFF2 fonts: readFileSync(path, "utf-8") replaces
// invalid UTF-8 sequences with U+FFFD (the 3-byte replacement
// char), and re-encoding through Buffer.from(str, "utf-8") writes
// those 3-byte expansions to disk, blowing up file size and
// breaking the WOFF2 magic. The browser then shows the broken-font
// icon and OTS rejects the file as "not a valid WOFF 2.0 font".
function uploadBinary(buf: Buffer, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => { conn.end(); reject(new Error("uploadBinary timeout")); }, 60000);
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { clearTimeout(timer); conn.end(); reject(err); return; }
        const ws = sftp.createWriteStream(remotePath, { mode: 0o644 });
        ws.on("close", () => { clearTimeout(timer); conn.end(); resolve(); });
        ws.on("error", (e: Error) => { clearTimeout(timer); conn.end(); reject(e); });
        ws.end(buf);
      });
    });
    conn.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    conn.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  });
}

// Recursively upload a local directory to a remote path. Skips dotfiles
// and node_modules if any sneaks in. The `clean` flag (default true)
// removes any pre-existing files in the remote directory that are NOT
// in the local source — this prevents stale Vite chunk hashes from
// piling up across deploys and the `index.html` accidentally pointing
// at a chunk that no longer exists.
//
// Subdirectory recursion always preserves the full local tree (no
// implicit clean), so the top-level call is the one that decides.
async function uploadDir(
  localDir: string,
  remoteDir: string,
  opts: { clean?: boolean } = { clean: true },
): Promise<void> {
  const clean = opts.clean !== false;
  const localEntries = readdirSync(localDir, { withFileTypes: true });
  await ssh(`mkdir -p "${remoteDir}"`);

  // If cleaning, list the remote directory first and delete any file
  // (not subdirectory) that doesn't have a matching local counterpart.
  // Subdirectories are recursed into — their contents are cleaned
  // recursively on the way in.
  if (clean) {
    const listRes = await ssh(
      `cd "${remoteDir}" 2>/dev/null && find . -mindepth 1 -maxdepth 1 -printf '%f\\n' || true`,
    );
    const remoteNames = new Set(
      listRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    );
    const localNames = new Set(
      localEntries
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => e.name),
    );
    for (const rn of remoteNames) {
      if (localNames.has(rn)) continue;
      // Only remove leaf entries (files + empty subdirs). Recursive
      // subdirs are handled by the upload step itself which rm's
      // their contents on the way in.
      const statRes = await ssh(
        `cd "${remoteDir}" && ([ -f "${rn}" ] && echo F || echo D)`,
      );
      if (statRes.stdout.trim() === "F") {
        await ssh(`rm -f "${remoteDir}/${rn}"`);
        console.log(`   (cleaned stale remote file ${rn})`);
      }
    }
  }

  for (const e of localEntries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "node_modules") continue;
    const lp = join(localDir, e.name);
    const rp = `${remoteDir}/${e.name}`;
    if (e.isDirectory()) {
      // Recurse without `clean` at the top — but DO clean on the
      // assets/ subdirectory so old Vite chunks are pruned. Other
      // subdirs (e.g. the source mirror) keep their remote history.
      const childClean = e.name === "assets" ? true : false;
      await uploadDir(lp, rp, { clean: childClean });
    } else if (e.isFile()) {
      // Read as raw Buffer so binary files (woff2, png, ico, jpg)
      // are not corrupted by the UTF-8 reader. See uploadBinary.
      const buf = readFileSync(lp);
      await uploadBinary(buf, rp);
    }
  }
}

// --- Main ---

async function main() {
  console.log(`=== Deploying MCP server (HTTP transport) to ${USER}@${HOST} ===\n`);

  // 1. Upload mcp-server.ts
  console.log("1. Uploading mcp-server.ts...");
  const mcpSrc = readFileSync(join(import.meta.dir, "mcp-server.ts"), "utf-8");
  await uploadText(mcpSrc, `${REMOTE_DIR}/mcp-server.ts`);
  console.log("   Done.");

  // 1b. Upload dashboard/ folder (login.html, dashboard.html, server.ts).
  //     The dashboard is only active when DASHBOARD_PASSWORD is set, so
  //     this is safe to ship even if the user doesn't enable it.
  const dashDir = join(import.meta.dir, "dashboard");
  if (existsSync(dashDir)) {
    console.log("1b. Uploading dashboard/...");
    await uploadDir(dashDir, `${REMOTE_DIR}/dashboard`);
    console.log("   Done.");
  }

  // 1c. Upload dashboard-v2 Vite build (dist/ → dashboard/v2/).
  //     The v2 SPA is served by server.ts from DASHBOARD_DIR/v2/, so
  //     we sync the local dist/ directory on top of the remote v2/.
  //     Stale asset hashes (Vite content-hashed filenames) are pruned
  //     automatically by uploadDir's clean-on-entry for "assets/".
  const v2Dist = join(import.meta.dir, "dashboard-v2", "dist");
  if (existsSync(v2Dist)) {
    console.log("1c. Uploading dashboard-v2/dist/ (Vue 3 SPA build)...");
    // Map dist/index.html → dashboard/v2/index.html on the remote.
    // Map dist/assets/   → dashboard/v2/assets/ (cleaned on entry).
    // Map any other top-level dist file the same way.
    const distEntries = readdirSync(v2Dist, { withFileTypes: true });
    for (const e of distEntries) {
      if (e.name.startsWith(".")) continue;
      const lp = join(v2Dist, e.name);
      const rp = `${REMOTE_DIR}/dashboard/v2/${e.name}`;
      if (e.isDirectory()) {
        // uploadDir's "assets" subdir gets cleaned automatically
        // (stale chunk hashes are pruned); other subdirs are merged.
        await uploadDir(lp, rp);
      } else if (e.isFile()) {
        // Read as raw Buffer so binary files (woff2, png, ico, jpg)
        // are not corrupted by the UTF-8 reader. See uploadBinary.
        const buf = readFileSync(lp);
        await uploadBinary(buf, rp);
      }
    }
    console.log("   Done.");
  } else {
    console.log("1c. dashboard-v2/dist/ not found — run `bun run build` in dashboard-v2/ first.");
  }

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

  // 5b. Read the dashboard passwords from /etc/cmms-api.env (if set).
  //     The dashboard feature is only active when at least one is set.
  //     The user + admin split was added so the operator UI and the
  //     standalone admin SPA can be opened by different people with
  //     different secrets; the legacy DASHBOARD_PASSWORD is forwarded
  //     as a fallback for both surfaces (matching the previous single-
  //     password behaviour).
  //
  //     IMPORTANT: the grep alternation must list DASHBOARD_PASSWORD
  //     LAST so it doesn't shadow the longer DASHBOARD_USER_PASSWORD /
  //     DASHBOARD_ADMIN_PASSWORD names. With ERE alternation, the
  //     engine matches positionally and the literal "DASHBOARD_PASSWORD"
  //     prefix does NOT contain the other two, so order doesn't
  //     actually matter for matching — but the existing comment is
  //     kept for documentation.
  const dashRes = await ssh(
    "cat /etc/cmms-api.env 2>/dev/null | grep -E '^DASHBOARD_(USER_PASSWORD|ADMIN_PASSWORD|PASSWORD)=' || true",
  );
  const dashUser = dashRes.stdout.match(/^DASHBOARD_USER_PASSWORD=(.+)$/m)?.[1]?.trim() ?? "";
  const dashAdmin = dashRes.stdout.match(/^DASHBOARD_ADMIN_PASSWORD=(.+)$/m)?.[1]?.trim() ?? "";
  const dashLegacy = dashRes.stdout.match(/^DASHBOARD_PASSWORD=(.+)$/m)?.[1]?.trim() ?? "";

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
    // User (operator) password for /dashboard/v2/login.
    dashUser ? `DASHBOARD_USER_PASSWORD=${dashUser}` : "",
    // Admin password for /dashboard/admin/login.
    dashAdmin ? `DASHBOARD_ADMIN_PASSWORD=${dashAdmin}` : "",
    // Legacy single-password fallback. server.ts uses it when the
    // explicit *USER / *ADMIN vars are unset.
    dashLegacy ? `DASHBOARD_PASSWORD=${dashLegacy}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await uploadText(mcpEnv, `${REMOTE_DIR}/mcp-cmms.env`);
  await ssh(`chmod 0600 ${REMOTE_DIR}/mcp-cmms.env`);
  console.log("   Done.");
  if (dashUser || dashAdmin || dashLegacy) {
    console.log(
      `   Dashboard passwords forwarded: user=${dashUser ? "set" : "fallback"} admin=${dashAdmin ? "set" : "fallback"} legacy=${dashLegacy ? "set" : "—"} — /dashboard is active.`,
    );
  } else {
    console.log("   No dashboard password set — /dashboard is disabled (returns 404).");
  }

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
