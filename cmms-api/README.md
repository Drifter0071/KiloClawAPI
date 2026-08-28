# cmms-api (pure-RAG)

A small Bun + Express + SQLite service that answers Hungarian/English
questions about the CMMS ticket database (`cmms.db`) through **one**
OpenAI-compatible endpoint:

```
POST /v1/chat/completions
```

Point any OpenAI-speaking UI (Lobe Chat, Open WebUI, LibreChat, curl)
at it. Retrieval is SQLite FTS5 (BM25) over ticket notes; the optional
LLM rewrite goes through the Kilo Gateway and is passed through a
grounding gate that rejects invented sorszams / customers / dates.

## Layout

```
src/
  db/            # SQLite connections + ETL (cmms.db -> cmms_specialized.db)
  lib/rag.ts     # FTS5 index build + BM25 search + ticket grouping
  lib/llm.ts     # Kilo Gateway client (rewrite step)
  lib/grounding.ts # zero-hallucination gate on the LLM output
  routes/        # /v1/health, /v1/chat/completions, auth
  server.ts      # express app factory
  index.ts       # bootstrap (open DBs, ETL, RAG build, watcher, listen)
tests/           # bun test suite (13 tests)
scripts/         # smoke.sh, build.sh, install helpers
```

## Quick start

```bash
bun install
CMMS_DB_PATH=./cmms.db CMMS_API_TOKEN_READ=dev bun dev
```

```bash
curl -s -H "authorization: Bearer dev" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Mi volt a B2408001 hiba?"}]}' \
  http://127.0.0.1:8787/v1/chat/completions
```

Without `KILO_API_KEY` set, the answer is the deterministic evidence
list (matched tickets with sorszam, date, customer, device, snippet).
With a key, the LLM rewrites it into prose and the grounding gate
verifies every cited fact.

See `../AGENTS.md` for deployment to 10.0.3.81 and the full architecture
notes.
