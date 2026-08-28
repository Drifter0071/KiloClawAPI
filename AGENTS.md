# Agents Configuration

## Architecture (pure-RAG rebuild, 2026-08-28)

The repo was deliberately stripped down. What exists now:

- **One endpoint**: `POST /v1/chat/completions` (OpenAI-compatible, JSON + SSE) — the "1 RAG tool".
- **One public probe**: `GET /v1/health` (no auth).
- **Retrieval**: SQLite FTS5 (BM25) over ticket notes, built by `cmms-api/src/lib/rag.ts`
  into `rag_chunks` (FTS5) + `rag_chunk_meta` (side table, joined via explicit rowid) in
  `cmms_specialized.db`. No embedding model, no MCP, no deterministic router.
- **LLM rewrite**: `cmms-api/src/lib/llm.ts` calls the Kilo Gateway (OpenAI-compatible)
  using `KILO_API_KEY` / `KILO_BASE_URL` / `KILO_MODEL`. If the key is unset the endpoint
  ships a deterministic evidence-only answer (matched tickets with sorszam + snippet).
- **Grounding gate**: `cmms-api/src/lib/grounding.ts` rejects any LLM output that cites a
  sorszam / customer / date not present in the retrieved chunks or the question; on reject
  the deterministic fallback ships. The endpoint never 500s on LLM failure.

What was removed (do not re-add without a fresh user request): the 28-tool MCP server,
the deterministic router/classifier/cluster/linkage engine, the Vue dashboards
(dashboard/, dashboard-v2/), the write endpoints (/v1/jobs, tickets, categories),
the integration ETL, and the zrok/cloudflared tunnel stack.

## Deployment

All code changes to `cmms-api/` must be published to the production server at `10.0.3.81` after implementation.

### Server Details

- **Host:** 10.0.3.81
- **User:** root
- **Password:** tarantula999
- **Remote dir:** /opt/cmms-api
- **REST API:** http://127.0.0.1:8787 (LAN-only; `cmms-api.service`)
- **Lobe Chat:** http://10.0.3.81:3210 (LAN-only; docker) — points at the endpoint above.
- No public tunnel. No zrok. No MCP HTTP port.

### How to deploy (the only path)

```powershell
cd cmms-api
bun build --compile --target=bun-linux-x64 --outfile=cmms-api-linux src/index.ts
bun run deploy-binary.ts
```

`deploy-binary.ts` stops `cmms-api.service`, SFTPs the binary to a temp name, `mv`s it
over the live path, and starts the service. There is no deploy-mcp.ts / deploy.ts
anymore — they were deleted with the MCP layer.

Restart note: without `CMMS_SKIP_FULL_ETL` in `/etc/cmms-api.env`, every restart runs a
full ETL (~3 min on the 65K-row production DB) and then rebuilds the FTS5 index. The
systemd watchdog tolerates this cold-start window.

### Server env (`/etc/cmms-api.env`)

- `CMMS_DB_PATH`, `CMMS_SPECIALIZED_DB`, `PORT`, `HOST`
- `CMMS_API_TOKEN_READ` — the only bearer token; Lobe Chat uses it as its API key.
- `KILO_API_KEY`, `KILO_MODEL`, `KILO_BASE_URL` — LLM rewrite; optional (deterministic
  fallback without it).

## NY/Z Polarity Convention

**NY/Z = 0 → closed** (lezárt)
**NY/Z = 1 → open** (nyitott)

This applies to `cmms.db` (`data` table) and `cmms_specialized.db` (`jobs.status`).

## Tests

```powershell
cd cmms-api
bun test        # pure-RAG suite: 13 tests, 40 expects, all green
bunx tsc --noEmit
```

`tests/fixtures/fixture.ts` builds a temp `cmms.db` with the real Hungarian column
schema; `tests/harness.ts` runs a full ETL + FTS5 build and boots the app on a random port.

## Ask-the-CMMS (Lobe Chat)

Lobe Chat runs in docker on the same box, bound to the LAN (3210), with an OpenAI
provider whose base URL is `http://10.0.3.81:8787/v1/chat/completions` (some Lobe
versions want `http://10.0.3.81:8787/v1` + model list) and the read token as API key.
Model name is arbitrary (server echoes it back); recommended display model: `cmms`.

## Data intake (manual, unchanged)

The human CMMS app writes new rows into `cmms.db` (`data` table). The file watcher on
the server picks changes up within ~1s, runs the incremental ETL, and rebuilds the FTS5
index. Bulk CSV drops go through the human CMMS app, not this repo.
