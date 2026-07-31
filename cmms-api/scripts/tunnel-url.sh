#!/usr/bin/env bash
# Print the current trycloudflare.com tunnel URL for cmms-api.
# The URL changes on every service restart; run this to find the current one.
#
# Exit codes:
#   0  URL printed
#   1  cloudflared not running or no URL found yet

set -euo pipefail

if ! systemctl is-active --quiet cloudflared-cmms.service 2>/dev/null; then
  echo "cloudflared-cmms is not running." >&2
  echo "Start it with:  systemctl start cloudflared-cmms" >&2
  exit 1
fi

TUNNEL_URL=$(journalctl -u cloudflared-cmms.service --no-pager -n 500 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)

if [ -z "$TUNNEL_URL" ]; then
  echo "No URL found in logs yet. Wait a few seconds and try again." >&2
  exit 1
fi

echo "$TUNNEL_URL"
