#!/usr/bin/env bash
# Refresh ~/tunnel-info.txt on the server with the current state.
# Run from this repo: bun run scripts/rewrite-tunnel-info.ts
MCP_ENV="/opt/cmms-api/mcp-cmms.env"
READ_TOKEN=$(grep CMMS_API_TOKEN_READ "$MCP_ENV" 2>/dev/null | cut -d= -f2 || true)
if [ -z "$READ_TOKEN" ]; then
  READ_TOKEN=$(grep CMMS_API_TOKEN_READ /etc/cmms-api.env 2>/dev/null | cut -d= -f2 || true)
fi
WRITE_TOKEN=$(grep CMMS_API_TOKEN_WRITE "$MCP_ENV" 2>/dev/null | cut -d= -f2 || true)
if [ -z "$WRITE_TOKEN" ]; then
  WRITE_TOKEN=$(grep CMMS_API_TOKEN_WRITE /etc/cmms-api.env 2>/dev/null | cut -d= -f2 || true)
fi
cat > ~/tunnel-info.txt <<EOF
REST API:    http://127.0.0.1:8787
MCP HTTP:    http://127.0.0.1:8788/mcp
Read Token:  ${READ_TOKEN:-(check /etc/cmms-api.env)}
Write Token: ${WRITE_TOKEN:-(check /etc/cmms-api.env)}

Tunneling is handled externally by zrok (not cloudflared).
Connect to the MCP endpoint via the zrok share URL.

== 20 MCP Tools (cmms-api v0.2.0, Phase 0 mcp-redesign) ==
search_existing_tickets  - find tickets; period filter (this_month, last_year, tavaly, ...)
create_ticket            - create a new ticket (customer_name required)
modify_ticket            - update fields on an existing ticket by sorszam
remove_ticket            - permanently delete a ticket (DANGEROUS)
get_ticket_stats         - aggregate by customer/device/controller/kategoria/...; include_evidence default ON
close_ticket             - close a ticket with optional solution text
get_categories           - list all available issue categories
get_tags                 - list all available tags
add_ticket_tag           - add a tag to a ticket (auto-creates if new)
set_ticket_category      - set the primary issue category on a ticket by sorszam
set_ticket_severity      - set severity level on a ticket
search_by_category       - fast category-based search
find_recurring_problems  - clusters of 2+ tickets sharing a root-cause signature
get_problem_cluster      - drill into one cluster for the full ticket list
search_serviz_belso      - search the internal szerviz archive (2008-now)
get_serviz_ticket        - fetch a single internal ticket by J-sorszam
search_szev_igeny        - search internal material/service requisitions (2019-now)
search_telephely_munka   - search in-house workshop jobs
search_ais_motor_inventory - list the bad-AiS-motor stock (51 motors)
get_integration_stats    - aggregate counts across the integrated CMMS data

All tool descriptions are bilingual (English + Hungarian).
All search/stats tools accept period (this_month, last_30_days, tavaly, ...)
and return a period echo with date_from/date_to in the response.

== Service controls ==
systemctl status cmms-api cmms-mcp
systemctl restart cmms-api cmms-mcp

== Logs ==
journalctl -u cmms-api -f
journalctl -u cmms-mcp -f

== Tunneling (zrok, not cloudflared) ==
The public tunnel is managed by zrok2 share public and points at 127.0.0.1:8788.
Check:   ps -ef | grep "zrok2 share"
Start:   zrok2 share public --subordinate -b proxy --name-selection public:nctmechanic http://localhost:8788
Legacy:  cloudflared-mcp.service is no longer used; do not re-create it.
EOF
echo "wrote ~/tunnel-info.txt"
