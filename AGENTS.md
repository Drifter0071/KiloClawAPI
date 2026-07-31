# Agents Configuration

## Deployment

All code changes to `cmms-api/` must be published to the production server at `10.0.3.81` after implementation.

### Server Details

- **Host:** 10.0.3.81
- **User:** root
- **Password:** tarantula999
- **Remote dir:** /opt/cmms-api
- **REST API:** http://127.0.0.1:8787
- **MCP HTTP:** http://127.0.0.1:8788

### What to deploy

| Change | What to run |
|--------|------------|
| `mcp-server.ts` only | `bun run deploy-mcp.ts` |
| `src/index.ts` or any `src/` file (REST API changes) | Rebuild binary: `bun build --compile --target=bun-linux-x64 --outfile=cmms-api-linux src/index.ts` then upload binary + MCP |
| Schema or DB changes | `bun run deploy.ts` (full deploy) |
| Any change at all | When in doubt, rebuild binary and run `deploy-full.ts` or equivalent |

### Deployment steps (MCP-only changes)

```bash
cd cmms-api
bun run deploy-mcp.ts
```

This uploads `mcp-server.ts`, `package.json`, `tsconfig.json` to 10.0.3.81, runs `bun install`, restarts `cmms-mcp.service`, creates a new cloudflared tunnel, and prints the new tunnel URL.

### Deployment steps (REST API / binary changes)

1. Rebuild the Linux binary:
   ```bash
   cd cmms-api
   bun build --compile --target=bun-linux-x64 --outfile=cmms-api-linux src/index.ts
   ```

2. Upload binary via SSH (use the existing `upload-binary.ts` or manual SFTP).

3. Restart the REST API service on the server:
   ```bash
   systemctl restart cmms-api
   ```

4. If the MCP server also changed, restart it too:
   ```bash
   systemctl restart cmms-mcp cloudflared-mcp
   ```

### After any tunnel restart

Quick tunnels (`trycloudflare.com`) get a **new URL on every restart**. After restarting `cloudflared-mcp`:

1. Wait ~10 seconds for the URL to appear in logs.
2. Grab the new URL:
   ```bash
   journalctl -u cloudflared-mcp --no-pager -n 50 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
   ```
3. Rewrite `~/tunnel-info.txt` on the server with the new URL. Use `bash ~/start.sh` on the server to do this automatically.

### Updating tunnel-info.txt

`start.sh` on the server auto-generates `~/tunnel-info.txt` with the current tunnel URL, tokens, tool list, and routing rules. To update it:

```bash
# On the server:
bash ~/start.sh
```

Or upload the file via the SSH deploy scripts.

### Services

| Service | Purpose | Port |
|---------|---------|------|
| `cmms-api.service` | REST API (Express, bun binary) | 8787 |
| `cmms-mcp.service` | MCP HTTP server (bun run mcp-server.ts) | 8788 |
| `cloudflared-mcp.service` | Cloudflare tunnel → MCP | — |

### Service control

```bash
systemctl status cmms-api cmms-mcp cloudflared-mcp
systemctl restart cmms-api cmms-mcp cloudflared-mcp
```

### Logs

```bash
journalctl -u cmms-api -f
journalctl -u cmms-mcp -f
journalctl -u cloudflared-mcp -f
```

### MCP Tools (12 total)

| Tool | Purpose |
|------|---------|
| `search_existing_tickets` | Find/dedup tickets by free text, customer, device, status, date range, **category**, **severity** |
| `create_ticket` | Create a new ticket (customer_name required, **category**, **severity**) |
| `modify_ticket` | Update fields on an existing ticket by sorszam (**category**, **severity**, **subcategory**) |
| `remove_ticket` | Permanently delete a ticket (dangerous) |
| `get_ticket_stats` | Aggregate tickets by customer/device/technician/status/month/**category**/**severity** (max 500) |
| `close_ticket` | Close a ticket with optional solution text |
| `get_categories` | List all available issue categories (Szoftver hiba, Hardver hiba, etc.) |
| `get_tags` | List all available tags for flexible labeling |
| `add_ticket_tag` | Add a tag to a ticket (auto-creates if new) |
| `set_ticket_category` | Set the primary issue category on a ticket by sorszam |
| `set_ticket_severity` | Set severity level (alacsony/kozepes/magas/kritikus) on a ticket |
| `search_by_category` | Fast category-based search (much faster than free-text for category queries) |

### Issue Categories (predefined)

| Category | Description |
|----------|-------------|
| Szoftver hiba | Software faults, PLC, updates, versioning, licensing |
| Hardver hiba | PCB, motherboard, CPU, memory, display hardware |
| Arampitlasi hiba | Power supply, voltage, fuses, power outages |
| Halozati hiba | Internet, WiFi, cables, network connectivity |
| Mechanikai hiba | Bearings, chains, belts, wear, mechanical damage |
| Kijelzo hiba | CRT, LCD, monitor, touchscreen issues |
| Tavoli eleres | Remote access, VPN, TeamViewer, RDP |
| Beallitasi hiba | Calibration, parameters, configuration, tuning |
| Karbantartas | Cleaning, lubrication, inspections, preventive |
| Telepites | Installation, commissioning, modifications |
| Csatlakozasi hiba | Connectors, plugs, sockets, cables |
| Kepzes | Training, documentation, user manuals |
| Egyeb | Unclassifiable issues, other |
| **Vezérlő hiba** | PLC, NC controller, controller software, programming, axis control |
| **Géptípus hiba** | Machine-type-specific faults, design/construction issues |

### Tool selection rules (for AI agents)

- **"Melyik ceghez tortent a legobb kiszallas?"** → `get_ticket_stats` (group_by: customer)
- **"Which device breaks most?"** → `get_ticket_stats` (group_by: device)
- **"How many open vs closed?"** → `get_ticket_stats` (group_by: status)
- **"Melyik a leggyakoribb hibatipus?"** → `get_ticket_stats` (group_by: kategoria)
- **"Mennyi kritikus hibas van?"** → `get_ticket_stats` (group_by: sulyossag)
- **"Melyik gep tipus a legproblemasabb?"** → `get_ticket_stats` (group_by: machine_type)
- **"Melyik vezerlo a legtobb hibat okozza?"** → `get_ticket_stats` (group_by: controller)
- **"Find a specific ticket"** → `search_existing_tickets`
- **"Search for a component/part"** → `search_existing_tickets` (q or notes_contains)
- **"Was this issue fixed before?"** → `search_existing_tickets` (notes_contains or q)
- **"Find tickets about X"** → `search_existing_tickets` (q or notes_contains)
- **"Show all software issues"** → `search_by_category` (kategoria: 'Szoftver hiba')
- **"List all categories"** → `get_categories`
- **DO NOT** use `search_existing_tickets` for counting/aggregation questions — use `get_ticket_stats` instead.
