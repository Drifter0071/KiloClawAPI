#!/usr/bin/env bash
# Probe cmms-api and restart it if it is unhealthy. Intended to be run
# from a cron job or systemd timer, e.g.:
#   */2 * * * *  /opt/cmms-api/scripts/healthcheck.sh >> /var/log/cmms-api-health.log 2>&1
#
# A "healthy" response is HTTP 200 with JSON { "ok": true, ... }.

set -euo pipefail

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
TOKEN="${CMMS_API_TOKEN_READ:-}"
MAX_RESTARTS="${MAX_RESTARTS:-3}"
RESTART_STATE="/var/tmp/cmms-api.restarts"

code=$(curl -s -o /tmp/cmms-api-health.json -w "%{http_code}" \
  -H "authorization: Bearer $TOKEN" \
  --max-time 5 \
  "http://$HOST:$PORT/v1/health" || echo "000")

if [ "$code" = "200" ]; then
  rm -f "$RESTART_STATE"
  echo "$(date -Iseconds) ok code=$code"
  exit 0
fi

# Unhealthy. Rate-limit restarts so we don't loop.
now=$(date +%s)
window_start=$now
if [ -f "$RESTART_STATE" ]; then
  window_start=$(awk '{print $1}' "$RESTART_STATE" 2>/dev/null || echo $now)
  count=$(awk '{print $2}' "$RESTART_STATE" 2>/dev/null || echo 0)
else
  count=0
fi
if [ $((now - window_start)) -gt 600 ]; then
  count=0
  window_start=$now
fi
count=$((count + 1))
echo "$window_start $count" > "$RESTART_STATE"

if [ "$count" -le "$MAX_RESTARTS" ]; then
  echo "$(date -Iseconds) unhealthy code=$code restart=$count"
  systemctl restart cmms-api
else
  echo "$(date -Iseconds) unhealthy code=$code NOT restarting (limit=$MAX_RESTARTS reached)"
  exit 1
fi
