// deploy-watchdog.cjs
// Phase 7 L2: install the cmms-api health watchdog on 10.0.3.81.
//
// Version 2: 2-strikes-and-you're-restarted. The previous version
// restarted on a single unhealthy tick, which thrashed during the
// 15-20s snapshot-driven cold-start (the service is genuinely
// healthy but not yet listening). Now we track the last-known
// state in /var/lib/cmms/watchdog-state and only restart after 2
// consecutive unhealthy ticks (one minute of unhealth).
//
// Three pieces installed:
//   1. /opt/cmms-api/watchdog.sh         - the polling script
//   2. /etc/systemd/system/cmms-api-watchdog.service - one-shot service
//   3. /etc/systemd/system/cmms-api-watchdog.timer  - 30s recurring timer
const { Client } = require("ssh2");

const HOST = "10.0.3.81";
const USER = "root";
const PASS = "tarantula999";
const REMOTE_DIR = "/opt/cmms-api";

const WATCHDOG_SCRIPT = `#!/bin/bash
# Phase 7 L2: cmms-api health watchdog (cold-start aware).
#
# Polls /v1/health and restarts cmms-api.service after 3
# consecutive unhealthy ticks. Cold-start aware: if the service
# was (re)started by systemd in the last 3 minutes, we KNOW it's
# still doing its 3-min full ETL or 30-60s snapshot-driven
# cold-start. In that grace window, we skip the strike counter
# and just log "still warming up". This prevents the watchdog
# from racing systemd's automatic Restart=on-failure.
#
# State file: /var/lib/cmms/watchdog-state
#   "healthy"        -> last tick was healthy
#   "unhealthy:N"    -> N consecutive unhealthy ticks (1, 2, or 3)
#   -> restart at N=3
#
# On healthy: state = "healthy", no restart.
# On unhealthy: increment strike counter. Restart at strike=3.

set -euo pipefail

LOG() { echo "$(date -Iseconds) [watchdog] $*"; }

STATE_FILE=/var/lib/cmms/watchdog-state
mkdir -p /var/lib/cmms

# Read the last known state. Default to "healthy" on first run.
LAST=$(cat "$STATE_FILE" 2>/dev/null || echo "healthy")

# Cold-start grace window: if systemd just (re)started the
# service in the last 180s, don't even probe. The full ETL takes
# 2-3 min, and the snapshot-driven cold-start (when L3 is
# enabled) takes 30-60s. Either way the service is genuinely up
# but not yet listening. systemctl gives us ActiveEnterTimestamp
# as a Unix epoch in microseconds.
START_TS=$(systemctl show cmms-api.service -p ActiveEnterTimestamp --value 2>/dev/null || echo "")
if [ -n "$START_TS" ]; then
  START_EPOCH=$(date -d "$START_TS" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  AGE=$((NOW_EPOCH - START_EPOCH))
  if [ "$AGE" -lt 300 ]; then
    LOG "cold-start grace: service is $AGE s old (< 300s), skipping health check"
    exit 0
  fi
fi

# /v1/health returns {"ok":true,"etl_mtime":...,"jobs":...}
# 3s timeout keeps the watchdog responsive if curl hangs.
RESP=$(curl -fsS -m 3 http://127.0.0.1:8787/v1/health 2>&1) || {
  CODE=$?
  case "$LAST" in
    "unhealthy:1") NEW="unhealthy:2" ;;
    "unhealthy:2") NEW="unhealthy:3" ;;
    *) NEW="unhealthy:1" ;;
  esac
  if [ "$NEW" = "unhealthy:3" ]; then
    LOG "unhealthy (3rd strike, curl exit=$CODE) — restarting cmms-api.service"
    echo "healthy" > "$STATE_FILE"
    systemctl restart cmms-api.service
  else
    LOG "unhealthy ($NEW, curl exit=$CODE) — recording strike, will restart on 3rd"
    echo "$NEW" > "$STATE_FILE"
  fi
  exit 0
}

if echo "$RESP" | grep -q '"ok":true'; then
  if [ "$LAST" != "healthy" ]; then
    LOG "recovered: ok=true (was: $LAST), state -> healthy"
  else
    LOG "healthy: ok=true, jobs=$(echo "$RESP" | grep -oE '"jobs":[0-9]+' | head -1 | cut -d: -f2)"
  fi
  echo "healthy" > "$STATE_FILE"
  exit 0
fi

# HTTP 200 but body doesn't say ok=true — unusual. Same logic.
case "$LAST" in
  "unhealthy:1") NEW="unhealthy:2" ;;
  "unhealthy:2") NEW="unhealthy:3" ;;
  *) NEW="unhealthy:1" ;;
esac
if [ "$NEW" = "unhealthy:3" ]; then
  LOG "unhealthy (3rd strike, response did not contain ok=true) — restarting cmms-api.service"
  echo "healthy" > "$STATE_FILE"
  systemctl restart cmms-api.service
else
  LOG "unhealthy ($NEW, response did not contain ok=true) — recording strike"
  echo "$NEW" > "$STATE_FILE"
fi
`;

const WATCHDOG_SERVICE = `[Unit]
Description=cmms-api health watchdog
After=network-online.target cmms-api.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/cmms-api/watchdog.sh
# No restart policy on the watchdog itself — if it ever fails,
# the timer just produces a journal error for the next tick.
`;

const WATCHDOG_TIMER = `[Unit]
Description=cmms-api health watchdog (every 30s)

[Timer]
# 30s tick: with 3-strike policy, real unhealth is caught within
# 90s. Still well before the user notices. Use OnCalendar=*:0/30
# instead of OnUnitActiveSec because the latter behaves oddly
# with Type=oneshot services that exit immediately — systemd
# can lose track of the "active" state. The cron-style calendar
# expression is rock-solid: every minute at second 0 and 30.
OnCalendar=*:*:0/30
AccuracySec=1s
Unit=cmms-api-watchdog.service
Persistent=true

[Install]
WantedBy=timers.target
`;

function ssh(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => { conn.end(); resolve({ code: -1, stdout, stderr: stderr + "\nTIMEOUT" }); }, timeout);
    conn.on("ready", () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(t); conn.end(); resolve({ code: 1, stdout, stderr: String(err) }); return; }
        stream.on("data", (d) => { stdout += d.toString(); });
        stream.stderr.on("data", (d) => { stderr += d.toString(); });
        stream.on("close", (code) => { clearTimeout(t); conn.end(); resolve({ code, stdout, stderr }); });
      });
    });
    conn.on("error", (e) => { clearTimeout(t); resolve({ code: 1, stdout: "", stderr: e.message }); });
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS });
  });
}

function upload(content, remotePath, mode = 0o644) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); reject(err); return; }
        const ws = sftp.createWriteStream(remotePath, { mode });
        ws.on("close", () => { conn.end(); resolve(); });
        ws.on("error", (e) => { conn.end(); reject(e); });
        ws.end(content);
      });
    });
    conn.on("error", reject);
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS });
  });
}

(async () => {
  console.log("=== Phase 7 L2 watchdog deploy (3-strike version) ===\n");

  console.log("1. Stopping the current (1-strike) timer...");
  await ssh("systemctl stop cmms-api-watchdog.timer || true");
  await ssh("systemctl disable cmms-api-watchdog.timer || true");
  console.log("   done.\n");

  console.log("2. Uploading watchdog.sh + systemd units...");
  await upload(WATCHDOG_SCRIPT, `${REMOTE_DIR}/watchdog.sh`, 0o755);
  await upload(WATCHDOG_SERVICE, "/etc/systemd/system/cmms-api-watchdog.service", 0o644);
  await upload(WATCHDOG_TIMER, "/etc/systemd/system/cmms-api-watchdog.timer", 0o644);
  console.log("   done.\n");

  console.log("3. Resetting state file + reloading daemon...");
  await ssh("echo healthy > /var/lib/cmms/watchdog-state && chown cmmsapi:cmmsapi /var/lib/cmms/watchdog-state 2>/dev/null || true");
  const r1 = await ssh("systemctl daemon-reload && echo RELOAD_OK");
  if (!r1.stdout.includes("RELOAD_OK")) {
    console.error("daemon-reload failed:", r1.stderr);
    process.exit(1);
  }
  console.log("   done.\n");

  console.log("4. Enabling + starting the watchdog timer...");
  const r2 = await ssh("systemctl enable cmms-api-watchdog.timer && systemctl restart cmms-api-watchdog.timer && echo TIMER_OK");
  if (!r2.stdout.includes("TIMER_OK")) {
    console.error("timer start failed:", r2.stderr);
    process.exit(1);
  }
  console.log("   done.\n");

  console.log("5. Timer status:");
  const r3 = await ssh("systemctl list-timers cmms-api-watchdog.timer --no-pager | head -10");
  console.log("   " + r3.stdout.split("\n").join("\n   "));
  console.log();

  console.log("6. Triggering one tick to verify the watchdog.sh works:");
  const r4 = await ssh("systemctl start cmms-api-watchdog.service && sleep 1 && journalctl -u cmms-api-watchdog -n 5 --no-pager");
  console.log("   " + r4.stdout.split("\n").slice(0, 10).join("\n   "));
  console.log();

  console.log("=== Watchdog deployed. 3-strike policy: restarts after 90s of continuous unhealth. ===");
})().catch((e) => { console.error("Deploy failed:", e); process.exit(1); });
