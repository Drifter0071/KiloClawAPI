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
- **Public URL (zrok share):** https://nctmechanic.shares.zrok.io/mcp

### What to deploy

| Change | What to run |
|--------|------------|
| `mcp-server.ts` only | `bun run deploy-mcp.ts` (binary + mcp-server.ts; tunnel is zrok, not cloudflared) |
| `src/index.ts` or any `src/` file (REST API changes) | Rebuild binary: `bun build --compile --target=bun-linux-x64 --outfile=cmms-api-linux src/index.ts` then upload via `bun run deploy-binary.ts` |
| Schema or DB changes | `bun run deploy.ts` (full deploy) |
| Any change at all | When in doubt, rebuild binary and run `deploy-full.ts` or equivalent |

### Deployment steps (MCP-only changes)

```bash
cd cmms-api
bun run deploy-mcp.ts
```

This uploads `mcp-server.ts`, `package.json`, `tsconfig.json` to 10.0.3.81,
runs `bun install`, restarts `cmms-mcp.service`, and refreshes
`~/tunnel-info.txt` on the server. The MCP HTTP server listens on
127.0.0.1:8788, fronted by the user's zrok share (NOT cloudflared).
The bearer token in `MCP_BEARER_TOKEN` matches `CMMS_API_TOKEN_READ` so
any client that already has the read token can use it directly.

### Deployment steps (REST API / binary changes)

1. Rebuild the Linux binary:
   ```bash
   cd cmms-api
   bun build --compile --target=bun-linux-x64 --outfile=cmms-api-linux src/index.ts
   ```

2. Upload binary and restart the service:
   ```bash
   cd cmms-api
   bun run deploy-binary.ts
   ```
   This stops `cmms-api.service`, SFTPs the binary to a temp name, `mv`s
   it over the live path, and starts the service. (The cmms-mcp.service
   keeps running on the existing binary until you also deploy that.)

3. If the MCP server also changed, restart it too:
   ```bash
   bun run deploy-mcp.ts
   ```

### Tunneling (zrok, not cloudflared)

The public URL `https://nctmechanic.shares.zrok.io/mcp` is a zrok
`public` share, fronting `127.0.0.1:8788` (the cmms-mcp HTTP server).

- **Check it's up:** `ps -ef | grep 'zrok2 share'`
- **Restart it:** `zrok2 share public --subordinate -b proxy --name-selection public:nctmechanic http://localhost:8788`
- **Important:** `cloudflared-mcp.service` has been removed. Do NOT
  re-create it. The deploy-mcp.ts script used to set up a cloudflare
  tunnel; that path is no longer in the script and would just
  generate a useless `trycloudflare.com` URL.

### Services

| Service | Purpose | Port |
|---------|---------|------|
| `cmms-api.service` | REST API (Express, bun binary) | 8787 |
| `cmms-mcp.service` | MCP HTTP server (bun run mcp-server.ts) | 8788 |
| `zrok2` (agent + share) | Public tunnel to MCP | — |

### Service control

```bash
systemctl status cmms-api cmms-mcp
systemctl restart cmms-api cmms-mcp
```

### Logs

```bash
journalctl -u cmms-api -f
journalctl -u cmms-mcp -f
```

### Tunnel URL rotation

`start.sh` on the server regenerates `~/tunnel-info.txt` with the
current state. To update it:

```bash
# On the server:
bash /opt/cmms-api/start.sh
# (or, to avoid the 60-90s ETL wait, just run scripts/tunnel-info.sh
# via the rewrite-tunnel-info.ts deploy script on this side)
```

## MCP Tools (26 total, cmms-api v0.4.0+)

All tool descriptions are bilingual (English + Hungarian). All
search/stats tools accept a `period` parameter (English: `this_month`,
`last_year`, `last_30_days`, `YTD`, `all`, `custom`; Hungarian aliases:
`ma`, `tavaly`, `idén`, `utolsó 30 nap`, `múlt hónap`, `minden`).
The response always echoes the resolved `date_from` / `date_to` so the
LLM can cite the window it actually used.

### Tool 0: Router (Phase 1)

| Tool | Purpose |
|------|---------|
| `answer_question` | **Primary tool.** Keyword-based router that parses the natural-language question, extracts customer/device/sorszam/period, classifies intent, and delegates to the correct primitive. Always call this first for any user question. Returns `{ intent, primitive, params, rationale, follow_ups }`. |

### Read / find (Phase 0 + Phase 1)

| Tool | Purpose |
|------|---------|
| `search_tickets` | **New (Phase 1).** Unified search with auto-extracted customer/device/sorszam/period, kategoria/severity filters, and `include_evidence`. Supersedes `search_existing_tickets` for most use cases. |
| `search_existing_tickets` | Find/dedup tickets by free text, customer, device, status, **period**, **category**, **severity** |
| `get_ticket_stats` | Aggregate tickets by customer/device/technician/status/month/**category**/**severity**/machine_type/controller. `include_evidence` default ON: each top-N result ships 1-2 sample sorszam + snippet |
| `search_by_category` | Fast category-based search (subset of `search_existing_tickets` with kategoria required) |
| `find_recurring_problems` | Find clusters of 2+ tickets sharing a root-cause signature. Accepts `period` |
| `get_problem_cluster` | Drill into one cluster. Accepts `period` |
| `search_serviz_belso` | Search the internal szerviz archive (2008-now) |
| `get_serviz_ticket` | Fetch a single internal ticket by J-sorszam |
| `search_szev_igeny` | Search internal material/service requisitions (2019-now) |
| `search_telephely_munka` | Search in-house workshop jobs |
| `search_ais_motor_inventory` | List the bad-AiS-motor stock (51 motors) |
| `get_integration_stats` | Aggregates across the integrated CMMS data |

### Integration (Phase 2)

| Tool | Purpose |
|------|---------|
| `get_failure_rates` | Per-model failure rates from the `statisztika` table. Accepts `period` and `model_filter`. |
| `find_spare_motor` | Find replacement motors from AiS stock. Accepts `serial_number`, `motor_type`, `problem`. Returns `match_score`. |
| `search_customers` | Substring search for customer names with per-customer ticket counts. |
| `customer_canonical` | Groups alias variants of the same real customer (e.g. "ANDRITZ KFT." / "ANDRITZ Magyarország Kft.") via in-memory folding. |

### Vocabulary

| Tool | Purpose |
|------|---------|
| `get_categories` | List all available issue categories (Szoftver hiba, Hardver hiba, …) |
| `get_tags` | List all available tags for flexible labeling |

### Mutate

| Tool | Purpose |
|------|---------|
| `create_ticket` | Create a new ticket (customer_name required) |
| `modify_ticket` | Update fields on an existing ticket by sorszam |
| `close_ticket` | Close a ticket with optional solution text |
| `add_ticket_tag` | Add a tag to a ticket (auto-creates if new) |
| `set_ticket_category` | Set the primary issue category on a ticket by sorszam |
| `set_ticket_severity` | Set severity level (alacsony/kozepes/magas/kritikus) |
| `remove_ticket` | **DANGEROUS** — permanently delete a ticket. Will be replaced by `cancel_ticket` in Phase 1 |

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
| **Vezérlő hiba** | PLC, NC vezérlő, controller software, programming, axis control |
| **Géptípus hiba** | Machine-type-specific faults, design/construction issues |

### Tool selection rules (for AI agents)

**Always start with `answer_question`** — pass the user's natural-language question as-is. The router returns `{ intent, primitive, params, rationale, follow_ups }` with deterministic keyword matching. Use the returned `primitive` and `params` to call the correct tool.

If the router returns `free_text`, fall back to `search_tickets` with the extracted params. If it returns `needs_clarification`, ask the user a targeted follow-up.

#### Quick reference (for when answer_question isn't available)

- **"Melyik ceghez tortent a legobb kiszallas?"** / "Which customer has the most tickets?" → `get_ticket_stats` (group_by: customer, **with period if "this year / idén / tavaly"**)
- **"Which device breaks most?"** → `get_ticket_stats` (group_by: machine_type)
- **"How many open vs closed?"** → `get_ticket_stats` (group_by: status)
- **"Melyik a leggyakoribb hibatipus?"** → `get_ticket_stats` (group_by: kategoria)
- **"Mennyi kritikus hibas van?"** → `get_ticket_stats` (group_by: sulyossag, **include_evidence: true** is default — use it!)
- **"Melyik gep tipus a legproblemasabb?"** → `get_ticket_stats` (group_by: machine_type)
- **"Melyik vezerlo a legtobb hibat okozza?"** → `get_ticket_stats` (group_by: controller)
- **"Find a specific ticket"** → `search_existing_tickets`
- **"Search for a component/part"** → `search_existing_tickets` (q or notes_contains)
- **"Was this issue fixed before?"** → `search_existing_tickets` (notes_contains or q)
- **"Find tickets about X"** → `search_existing_tickets` (q or notes_contains)
- **"Show all software issues"** → `search_by_category` (kategoria: 'Szoftver hiba')
- **"List all categories"** → `get_categories`
- **"Which motor to replace?"** → `find_spare_motor`
- **"What's the failure rate?"** → `get_failure_rates`
- **DO NOT** use `search_existing_tickets` for counting/aggregation questions — use `get_ticket_stats` instead.
- **For time-bounded recall**, always pass `period` (e.g. `last_year`, `this_month`, `tavaly`, `utolsó 30 nap`) rather than computing `date_from` / `date_to` yourself. The server echoes the resolved window so the LLM can cite it.
- **For "recurring" / "keeps happening"** questions, prefer `find_recurring_problems` over raw `get_ticket_stats` — it clusters tickets by root-cause signature.

## NY/Z Polarity Convention

**NY/Z = 0 → closed** (lezárt, ticket is done)
**NY/Z = 1 → open** (nyitott, ticket is still active)

This applies to both `cmms.db` (`data` table) and `cmms_specialized.db`
(`jobs.status` column). All write paths (create, close, modify) and
read paths (ETL, makeCardFromSpec, cache) use this convention.

## Smoke test

```bash
cd cmms-api && bun test     # 237 tests, 0 failures, 1412 expects
```

## Phase 0 changelog (mcp-redesign-phase0 branch)

Released 2026-07-31. All 153 tests pass; deployed to production.

- **Bilingual tool descriptions** — every MCP tool now has English +
  Hungarian in its description and parameter help. LLM no longer
  translates the question twice.
- **`period` parameter on every search/stats tool** — server-side
  resolution of tokens like `this_month` / `last_30_days` / `tavaly`
  / `utolsó 30 nap` into concrete ISO dates. Bilingual response echo
  (`label_en` / `label_hu`) so the answer can cite the window.
- **`include_evidence` default ON for `get_ticket_stats`** — every
  top-N group ships 1-2 sample sorszam + reported-text snippet so
  answers cite real tickets instead of trusting the count.
- **HTTP smoke test fixed** — `unknown session returns 404` was
  asserting an exact 404, but the SDK now returns 400. Test now
  accepts any 4xx.
- **Pre-existing write-path bug fixed** — `createNewJob` was
  inserting into the spec DB with 7 values; the `insertJob`
  statement now expects 10 (after the kategoria/alkategoria/sulyossag
  columns were added). Without this fix, no new tickets could be
  created.
- **Server `tunnel-info.txt` regenerated** — now lists 20 tools,
  bilingual notes, zrok as the tunnel, and explicitly says
  `cloudflared-mcp.service` is removed.
- **Legacy `cloudflared-mcp.service` removed** — was creating a
  useless trycloudflare URL. `deploy-mcp.ts` no longer sets it up.
- **New `deploy-binary.ts`** — minimal binary-only deploy, no DB
  upload, used when only `src/` changed and the schema didn't.

Next: Phase 1 (answer_question router + search_tickets + inferred
kategoria/severity). See `docs/cmms-mcp-redesign.md` for the full
plan and the 100-question catalog.

## Phase 1 changelog (mcp-redesign-phase1 branch)

- **`answer_question` router** — tool 0, keyword-based deterministic
  router that classifies intent and returns `{ intent, primitive, params }`.
- **`search_tickets`** — unified search with auto-extracted customer/device/
  sorszam/period, kategoria/severity filters, evidence.
- **Inferred columns** — `kategoria_inferred`, `sulyossag_inferred`,
  `alkategoria_inferred` with confidence scores. Backfilled on first
  restart (gated by `_meta.phase1_backfill_done`).
- **Classifier** — deterministic keyword+regex classifier for kategoria/
  sulyossag/alkategoria. Runs on create and ETL.
- **15 test files** — 237 tests covering meta, read, write, parse, MCP,
  MCP-HTTP, tickets, tickets-modify, period, router, classifier, inferred,
  backfill-index, phase2, and 100-question regression catalog.

## Phase 2 changelog (mcp-redesign-phase2 branch)

- **`get_failure_rates`** — per-model failure rates from `statisztika`.
- **`find_spare_motor`** — spare motor lookup with match_score scoring.
- **`search_customers`** — substring search with per-customer ticket counts.
- **`customer_canonical`** — groups alias variants via in-memory folding.
- **Integration primitives wired into `answer_question`** — regex extractors
  for machine_serial, motor_type, problema, product name. Table-existence
  guards prevent crashes on test fixtures.

## Phase 3 changelog (mcp-redesign-phase3 branch, in progress)

- **NY/Z polarity correction** — all code and fixtures now use 0=closed,
  1=open (was inverted). Touched ~10 source files + ~6 test fixtures.
- **Router bug fixes** — `extractDevice()` M-serial regex missing capture
  group; `has()` false-positive on "ma" inside "Melyik"; missing English
  triggers for critical/machine/status intents.
- **100-question regression catalog** (`15-regression-100.test.ts`) —
  100 cases from design doc §5.1-5.8, 753 expects, determinism tests
  (10x stress + pairwise), bilingual coverage, period round-trip.
- **AGENTS.md updated** — 26-tool surface, v0.4.0, NY/Z convention,
  Phase 1-3 architecture, smoke test command.
