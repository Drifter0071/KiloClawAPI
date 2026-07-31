#!/usr/bin/env bash
# cmms-api start / restart script
# Starts REST API and MCP HTTP server only.
# Tunneling is handled externally by zrok.
set -euo pipefail

GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
BOLD="\033[1m"
NC="\033[0m"

echo ""
echo "=== cmms-api control panel ==="
echo ""

REMOTE_DIR="/opt/cmms-api"
REST_PORT=8787
MCP_PORT=8788

# ── 1. Start/restart cmms-api (REST) ──
echo -e "${BOLD}1. Starting cmms-api (REST on :$REST_PORT)...${NC}"
if systemctl is-active --quiet cmms-api; then
  echo -e "  ${GREEN}Service already running. Restarting...${NC}"
  systemctl restart cmms-api
else
  echo -e "  ${YELLOW}Service not running. Starting...${NC}"
  systemctl start cmms-api
fi

# ── 2. Start/restart cmms-mcp (MCP HTTP server) ──
echo -e "${BOLD}2. Starting cmms-mcp (MCP HTTP on :$MCP_PORT)...${NC}"
if systemctl is-active --quiet cmms-mcp; then
  echo -e "  ${GREEN}Service already running. Restarting...${NC}"
  systemctl restart cmms-mcp
else
  echo -e "  ${YELLOW}Service not running. Starting...${NC}"
  systemctl start cmms-mcp
fi

# ── 3. Wait for ETL ──
echo ""
echo -e "${BOLD}3. Waiting for API to become healthy (ETL takes ~1 min)...${NC}"
HEALTHY=false
for i in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$REST_PORT/v1/health" 2>/dev/null | grep -q "ok"; then
    HEALTHY=true
    break
  fi
  sleep 2
  echo -n "."
done
echo

if [ "$HEALTHY" = true ]; then
  echo -e "  ${GREEN}REST API is healthy!${NC}"
else
  echo -e "  ${RED}REST API not responding. Check: journalctl -u cmms-api -f${NC}"
fi

# ── 4. Wait for MCP HTTP server ──
echo ""
echo -e "${BOLD}4. Waiting for MCP HTTP server (:$MCP_PORT)...${NC}"
MCP_UP=false
for i in $(seq 1 20); do
  if curl -fsS -X POST "http://127.0.0.1:$MCP_PORT/mcp" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"healthcheck","version":"0.1"}}}' \
    2>/dev/null | grep -q "serverInfo"; then
    MCP_UP=true
    break
  fi
  sleep 2
  echo -n "."
done
echo

if [ "$MCP_UP" = true ]; then
  echo -e "  ${GREEN}MCP server is healthy!${NC}"
else
  echo -e "  ${RED}MCP not responding. Check: journalctl -u cmms-mcp -f${NC}"
fi

# ── 5. Write ~/tunnel-info.txt ──
MCP_ENV="$REMOTE_DIR/mcp-cmms.env"
READ_TOKEN=$(grep CMMS_API_TOKEN_READ "$MCP_ENV" 2>/dev/null | cut -d= -f2 || true)
if [ -z "$READ_TOKEN" ]; then
  READ_TOKEN=$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env 2>/dev/null | cut -d= -f2 || true)
fi
WRITE_TOKEN=$(grep CMMS_API_TOKEN_WRITE "$MCP_ENV" 2>/dev/null | cut -d= -f2 || true)
if [ -z "$WRITE_TOKEN" ]; then
  WRITE_TOKEN=$(grep CMMS_API_TOKEN_WRITE /etc/cmms-api.env 2>/dev/null | cut -d= -f2 || true)
fi

echo ""
echo -e "${BOLD}5. Writing ~/tunnel-info.txt...${NC}"
cat > ~/tunnel-info.txt <<EOF
REST API:    http://127.0.0.1:$REST_PORT
MCP HTTP:    http://127.0.0.1:$MCP_PORT/mcp
Read Token:  ${READ_TOKEN:-"(check /etc/cmms-api.env)"}
Write Token: ${WRITE_TOKEN:-"(check /etc/cmms-api.env)"}

Tunneling is handled externally by zrok.
Connect to the MCP endpoint via the zrok share URL.

== 12 MCP Tools ==
search_existing_tickets  - find/dedup tickets by free text, customer, device, status, date range
create_ticket            - create a new ticket (customer_name required)
modify_ticket            - update fields on an existing ticket by sorszam
remove_ticket            - permanently delete a ticket (dangerous)
get_ticket_stats         - aggregate tickets by customer/device/technician/status/month (max 500 results)
close_ticket             - close a ticket with optional solution text
get_categories           - list all available issue categories
get_tags                 - list all available tags
add_ticket_tag           - add a tag to a ticket (auto-creates if new)
set_ticket_category      - set the primary issue category on a ticket by sorszam
set_ticket_severity      - set severity level on a ticket
search_by_category       - fast category-based search

== Service controls ==
systemctl status cmms-api cmms-mcp
systemctl restart cmms-api cmms-mcp

== Logs ==
journalctl -u cmms-api -f
journalctl -u cmms-mcp -f

== Regenerate tunnel-info.txt ==
bash ~/start.sh
EOF
echo -e "  ${GREEN}Saved to ~/tunnel-info.txt${NC}"

echo ""
echo "======================================="
echo "  REST API : http://127.0.0.1:$REST_PORT"
echo "  MCP HTTP : http://127.0.0.1:$MCP_PORT"
echo "  Logs     : journalctl -u cmms-api -f"
echo "  Info     : cat ~/tunnel-info.txt"
echo "======================================="
