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
- **Edge response cap ~60s (2026-08-19):** the zrok edge cuts proxied
  responses at ~60s (`504 Gateway Time-out` at 60.2s, measured through
  `/dashboard/api/answer-agent`). The agent loop therefore runs a soft
  deadline (`AGENT_SOFT_DEADLINE_MS`, default 35s in `src/lib/agent.ts`):
  past it, the LLM round ships WITHOUT the tool list and must write the
  final answer from the evidence gathered. Tune via
  `AGENT_SOFT_DEADLINE_MS` in `/etc/cmms-api.env` if the edge cap or
  model latency changes. Diagnostic: journal log
  `agent_soft_deadline_forced` fires per forced answer.
- **Do NOT create `zrok.service` (system unit):** it crash-loops forever
  with 409 shareConflict against the working user-level share
  (`zrok2-agent.service` under `systemd --user`). Disabled 2026-08-19.

### Dashboard (control plane)

The mcp-server.ts process also serves a password-gated operator
dashboard at `/dashboard` (served on port 8788, reachable through the
zrok tunnel as `https://nctmechanic.shares.zrok.io/dashboard`).

- **Off by default** — the route returns 404 unless `DASHBOARD_PASSWORD`
  is set in `/etc/cmms-api.env` on the server.
- When set, the user sees a login page, enters the password, and gets
  a signed `HttpOnly`+`SameSite=Strict` cookie (8h TTL).
- The dashboard then proxies API calls to cmms-api with the read or
  write bearer token (depending on the operation).
- Set or rotate the password: `ssh root@10.0.3.81 'echo "DASHBOARD_PASSWORD=new" >> /etc/cmms-api.env'` (or edit `/etc/cmms-api.env` directly), then re-run `bun run deploy-mcp.ts` to push the new env to `/opt/cmms-api/mcp-cmms.env` and restart the service.
- 4 modules: Live Stream+Approval, Spatial Map, Diff/Revert, Token Portal
- 9 unit tests in `tests/24-dashboard-auth.test.ts`

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

## MCP Tools (28 total, cmms-api v0.6.0+)

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

### Cross-database (Phase 4)

| Tool | Purpose |
|------|---------|
| `find_related_tickets` | **Cross-database timeline.** Given a sorszam or customer+device, search across main CMMS, serviz_belso, szev_igeny, and telephely_munka for all related entries. Returns a chronological timeline with source labels. Accepts `sorszam`, `customer`, `device`, `period`, `window_days` (default 180). |

### Ticket linkage (Phase 5b)

| Tool | Purpose |
|------|---------|
| `find_linkage` | **Sorszam cross-reference graph.** Looks up which tickets reference a given sorszam (forward), which sorszams a ticket references (reverse), the top "hub" tickets by indegree, or the global total. Built from note bodies at startup via strict regex + catalog validation. Use for "melyik munkához történt a legtöbb kiszállás?" / "which work order had the most references?". |

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
- **"Show me the full history for this case"** / "folytatás", "előzmények", "related" → `find_related_tickets` (sorszam or customer+device)
- **"melyik munkához történt a legtöbb kiszállás?"** / "which work order had the most references?" / "central case" → `find_linkage` with `direction=top_hubs` (uses the sorszam cross-reference graph built from note bodies)
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
cd cmms-api && bun test     # 514 tests, 0 failures, 2265 expects
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

## Phase 5 changelog (mcp-redesign-phase5 branch)

Released 2026-08-11. 290 tests pass, 0 failures, 1571 expects across
18 files. MCP tool surface 27 -> 28.

- **Phase 5a — cluster cross-DB evidence**: each recurring-problem
  cluster now ships a `related_integration` field with up to 2 sample
  rows from each of serviz_belso, szev_igeny, telephely_munka, matched
  by cluster signature (customer + machine). New module
  `cmms-api/src/lib/cluster_evidence.ts`. Wired into
  `POST /v1/jobs/recurring-problems` and
  `POST /v1/jobs/recurring-problems/cluster`.
- **Phase 5b — ticket-linkage scanner**: in-memory forward+reverse
  index of every sorszam cross-reference found in note bodies. Built
  once during `JobCache.buildFromDb()` (~300ms for 65K tickets).
  Strict regex (`[A-Z]-YYYY/NNNN`, `B2408001` compact, `B-YYYYMMMM`)
  plus catalog validation: any candidate not in the known sorszam
  set is dropped. Exposed as:
    - new `linkage` field on every cluster summary
      (`hub_sorszam` + `hub_referenced_by_count` — the ticket in the
      cluster that is mentioned by the most other tickets)
    - new REST endpoint `GET /v1/jobs/linkage?direction=...`
      (`stats` / `top_hubs` / `referenced_by` / `references`)
    - new MCP tool #28 `find_linkage`
    - new router intent `top_hubs` triggered by
      "melyik munkahoz jartunk ki a legtobbszor?" and
      "which work order had the most references?"
- **Bilingual period aliases** remain server-side
- **No breaking changes to REST surface** (additive only)
- **No LLM call server-side**; linkage is pure regex + catalog lookup

## Phase 6 changelog — bare-customer detection + fleet overview (commit aeb3d1f)

User-reported 2026-08-25: "Hány alkalommal ment tönkre az SVG HDMC gépében
az y2 hajtás" returned "0 kapcsolódó jegy" because `SVG HDMC` is a customer
name (SVG-HUNGARY GÉPGYÁR ZRT.), not a machine — the router had no rule
for bare ALL-CAPS phrases without a legal suffix (`Kft.`, `Zrt.`, etc.).

Two related fixes shipped:

- **Bare-customer detection** — new 4th pattern in `extractCustomer`
  (src/lib/router.ts) matches bare 1-3 token ALL-CAPS phrases. Excludes
  question words (Melyik/Mikor/Hány/Milyen/Mit/Hány/Van-e/Volt-e/Jobbak/
  Foglald/Készíts/Töröld/…), Hungarian demonstratives (Ezzel/Ezt/Ennek/
  Most/Már/…), English demonstratives (This/That/These/…), and known
  device-model prefixes (TMV/NCT/DPB/DxC/IPS/KAFO/EML/…). Tokens with
  3+ identical consecutive letters (Hubbbubbbla) are also rejected as
  typing noise. Router tags the plan with `weak_customer` so the
  answer handler can run a `search_customers` DB probe
  (`probeCustomer` in src/routes/answer.ts) before honoring the filter;
  a 0-hit probe discards the weak signal and the question falls
  through to the device / free-text branch.

- **customer_fleet_overview intent** — bare-name questions like
  `"SVG HDMC"` alone (no question verb) now produce a 5-section
  composite: (1) total ticket count + distinct machine types, (2) top
  5 machine types, (3) top 5 failure categories, (4) top 3 technicians,
  (5) last 5 tickets + first/most-recent date + 1-line summary.
  Both Hungarian and English. The intent is set by the answer
  handler after the customer probe confirms a real customer match
  AND the question has no leftover `q` (compound questions like
  "Hány y2 hajtás … az SVG HDMC …" keep the existing
  `customer_tickets_list` intent so the descriptive `q` is threaded
  through the search).

Test results: `tests/38-customer-fleet.test.ts` (10 cases, all pass);
full suite 656 pass, 10 fail, 3 errors (all pre-existing — none
introduced by this change). `bunx tsc --noEmit` clean on new code.
No breaking changes to REST surface. No LLM call server-side.

## Phase 7 changelog — Resilience + cold-start hardening (commit e1f7a8b)

User-reported 2026-08-25: "the CMMS api randomly goes down and never
comes back up, this happens after asking a few questions, and then
boom, its gone." Investigated the prod journal and found:
- 4 process crashes in 24h, all `status=1/FAILURE`
- systemd's `Restart=on-failure` did recover each crash in 5s
- BUT the 3-min full ETL means the service is functionally dead
  for 3 min after every crash
- AND the crashes weren't from resource exhaustion — they were
  from `TypeError: undefined is not an object (evaluating
  'composite.topMachines.map')` thrown from a synchronous `.map`
  callback in `buildSummary`, which the express error middleware
  never saw, so Bun killed the process

Three layers shipped:

**L1 (process safety)**:
- `safeBuildSummary()` + `safeExecutePlan()` wrappers in `src/routes/answer.ts`
  catch any throw from the 4 `buildSummary` / `executePlan` call
  sites (2 in the main path, 1 in the LLM-render path, 1 in the
  candidate-render path). A throw becomes a logged
  `build_summary_failed` event + a 200 with a fallback Hungarian
  ("Belső hiba a válasz összeállításakor — a fejlesztői csapat
  értesítve"). The request still completes.
- `process.on('uncaughtException')` + `process.on('unhandledRejection')`
  in `src/index.ts` as the last-resort safety net. Log + survive;
  do NOT exit. The watchdog handles the cleanup.

**B1 (composite nullish guards)**:
- `customer_fleet_overview` composite builder now defaults each
  per-field array (`topMachines`, `topCategories`,
  `topTechnicians`, `last5`) to `[]` instead of leaving them
  undefined. The consumer side also reads the defaulted locals
  (not the composite's raw fields). A malformed sub-query can no
  longer crash the .map chain.

**L2 (systemd watchdog)**:
- New `cmms-api-watchdog.{service,timer}` units poll
  `/v1/health` every 30s and restart `cmms-api.service` after
  3 consecutive unhealthy ticks (90s of unhealth).
- **Cold-start grace**: reads `ActiveEnterTimestamp` and skips
  probes for the first 5 min after a (re)start. Without this the
  watchdog races systemd's automatic restart during the 3-min
  full ETL.
- **State file**: `/var/lib/cmms/watchdog-state` tracks the
  strike count across ticks. Reset to "healthy" on every
  successful probe.
- Deployed via `node deploy-watchdog.cjs` (uploads 3 files,
  enables + starts the timer, runs a smoke test).
- **First-strike version was 1-strike; tested on prod, caused
  thrash during 30s cold-start windows. Upgraded to 2-strike
  then 3-strike + cold-start grace.**

**L3 (cache snapshot persistence)** — coded and tested, disabled
by default on the 3.8GB prod box:
- `JobCache.saveSnapshot()` writes a gzip-compressed JSON file
  (envelope: `{ version: 2, cmmsMtimeMs, jobCount, byKey }`)
  after every `buildFromDb`. Atomic write (temp + rename).
- `JobCache.loadSnapshot()` reads it back on startup; if the
  embedded cmms.db mtime matches the live one, the snapshot
  is current and we skip the 3-min ETL.
- `rebuildDerived()` repopulates `prefixIndex`, `indexCard`,
  `linkage`, etc. from the loaded `byKey` in <1s. Only the
  per-card `_haystack` search index is OMITTED from the
  snapshot (it's recomputed by `rebuildDerived` from the
  rest of the card data; saves ~30-40% of snapshot size).
- Test results: `tests/41-resilience.test.ts` 7/7 pass
  (roundtrip, stale-mtime rejection, missing-file, malformed-
  gzip, rebuild-derived-then-search, L1 graceful fallback,
  cold-start roundtrip). Full suite 679/689 pass, 10
  pre-existing failures unchanged.
- **Disabled in production** via `CMMS_SKIP_CACHE_SNAPSHOT=1`
  in `/etc/cmms-api.env`. The 67MB v1 snapshot pegged
  Bun's allocator at 3.5GB during load, OOM-killing the
  process on the 3.8GB prod box. v2 (without _haystack)
  would be ~40MB but the box is too small either way. The
  watchdog (L2) provides the recovery guarantee without
  the memory pressure. **To re-enable on a bigger box:**
  remove `CMMS_SKIP_CACHE_SNAPSHOT=1` from
  `/etc/cmms-api.env` and restart.

**Memory cap (new)**:
- `MemoryMax=3.5G`, `MemoryHigh=3G`, `MemorySwapMax=0` in
  `/etc/systemd/system/cmms-api.service.d/memory-cap.conf`.
  The cmms-api steady-state is ~2.5GB (cache + Bun
  allocator). 3.5G hard cap leaves 1.3G for the rest of
  the system (zrok, sshd, journald, OS) on a 3.8G box.
  `MemorySwapMax=0` prevents swap thrashing (Linux OOM
  killer is more predictable than swap death).

**Deployed + verified**:
- Binary built, uploaded via `bun run deploy-binary.ts`,
  restarted `cmms-api.service`. Verified 8/8 regression
  questions route correctly via `node _run-prod-probe.cjs`.
- Watchdog deployed via `node deploy-watchdog.cjs`.
  Verified a `pkill -9` of cmms-api is followed by:
  tick 1: "1st strike", tick 2: "2nd strike", tick 3:
  "3rd strike, restarting", then ~10s snapshot-free
  cold-start, then `healthy: ok=true, jobs=65921`. Total
  recovery: ~2-3 min (vs the 3+ min before Phase 7 from
  full ETL, but with the watchdog the user no longer has
  to do anything to trigger the recovery).

**Caveats**:
- L3 (cache snapshot) is OFF on the prod box — see above.
  On a box with 6GB+ RAM, remove `CMMS_SKIP_CACHE_SNAPSHOT=1`
  and the cold-start drops from 3 min to <10s.
- The watchdog's 5-min cold-start grace means a process that
  crashes DURING the ETL won't be detected (it just gets
  restarted by systemd). After the 5-min mark, the watchdog
  catches hang-on-listening cases.
- The 3.5G memory cap is set for THIS box (3.8G total). On a
  bigger box, raise it to match the cache size + 1GB headroom.


