<div align="center">

# 🟣 NCT Claw API

**A Bun + SQLite service that puts your CMMS data in front of an AI — safely, fast, and grounded in real tickets.**

<br/>

<p align="center">
  <img
    width="480"
    height="320"
    alt="NCT Claw API"
    src="https://github.com/user-attachments/assets/bdc5dba4-3f4a-4c2b-8c7f-df1c10a07cda"
    style="border: 3px solid #8b5cf6; border-radius: 12px; box-shadow: 0 0 24px rgba(139, 92, 246, 0.35);"
  />
</p>

<br/>

[![Made with Bun](https://img.shields.io/badge/Made%20with-Bun-000?style=for-the-badge&logo=bun&logoColor=fbf0df)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![SQLite](https://img.shields.io/badge/SQLite-07405E?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![License](https://img.shields.io/badge/license-Private-8b5cf6?style=for-the-badge)](#)

</div>

---

## ✨ What is this?

`cmms-api` is the back-end for **NCT**, the industrial service company's internal
CMMS. It serves a `cmms.db` SQLite archive of past service jobs to an AI assistant
over a single OpenAI-compatible endpoint, so on-the-ground technicians can ask
*"what did we do last time this DPB-2 broke at ANDRITZ?"* and get a real, grounded
answer in seconds.

The AI surface is **pure RAG**: SQLite FTS5 (BM25) retrieval over ticket notes,
with an optional LLM rewrite (Kilo Gateway) behind a grounding gate. No MCP,
no tool-calling, no deterministic router — just retrieval + generation that
*cites real sorszams or doesn't claim them*.

---

## 🚀 Features

| | |
|---|---|
| 🟣 **One endpoint** | `POST /v1/chat/completions` — OpenAI-compatible, JSON + SSE |
| ⚡ **Bun-powered** | Single self-contained Linux binary, no Node.js runtime on the server |
| 🗄️ **SQLite FTS5** | BM25 full-text search over ticket notes — no embeddings, no vector DB |
| 🔐 **Bearer-token auth** | One read token; Lobe Chat uses it as its API key |
| 🔄 **Live ETL** | File watcher re-ingests when `cmms.db` changes (~1s) |
| 🧠 **Optional LLM rewrite** | Kilo Gateway (`openai/gpt-5.6-luna-pro`); deterministic fallback without it |
| 🛡️ **Grounding gate** | Rejects any LLM output citing a sorszam/customer/date not in the retrieved chunks |
| 🌍 **Hungarian data** | All ticket text, customer names, device IDs are HU — the LLM sees them as-is |
| 🧪 **13 tests** | Pure-RAG suite, 40 expects, all green |

---

## 📦 What's in the box

```
KiloClawAPI/
├── cmms-api/                 # The service
│   ├── src/
│   │   ├── db/               # SQLite connections, ETL, device parser
│   │   ├── lib/
│   │   │   ├── rag.ts        # FTS5 (BM25) retrieval → rag_chunks + rag_chunk_meta
│   │   │   ├── llm.ts        # Kilo Gateway rewrite (optional)
│   │   │   └── grounding.ts  # Grounding gate — rejects ungrounded citations
│   │   ├── routes/
│   │   │   ├── answer.ts     # POST /v1/chat/completions
│   │   │   ├── auth.ts       # Bearer-token middleware
│   │   │   └── health.ts     # GET /v1/health
│   │   ├── schema/schema.json
│   │   ├── server.ts         # Express app factory
│   │   └── index.ts          # Bootstrap + file watcher
│   ├── tests/                # bun test suite, 13 tests
│   ├── deploy-binary.ts      # Build → SFTP → restart
│   └── _start-lobe.sh        # Lobe Chat + Casdoor SSO container stack (local helper)
├── docs/                     # Design docs
├── newIntegrationCSVs/       # Source data for the specialized DB
├── AGENTS.md                 # Agent operating manual (deploy, env, conventions)
└── README.md                 # This file
```

---

## ⚙️ Quick start

```bash
cd cmms-api
bun install
cp .env.example .env       # fill in CMMS_DB_PATH + (optional) KILO_API_KEY
bun run src/index.ts
```

Health check on `http://127.0.0.1:8787/v1/health`.

## 🧪 Test

```bash
cd cmms-api
bun test                   # 13 tests, 40 expects, all green
bunx tsc --noEmit          # Type-check
```

## 📦 Build the binary

```bash
cd cmms-api
bun build --compile --target=bun-linux-x64 \
  --outfile=cmms-api-linux src/index.ts
```

Single self-contained executable. Copy to the server, restart the systemd
unit, done.

## 🚢 Deploy

```bash
cd cmms-api
bun build --compile --target=bun-linux-x64 --outfile=cmms-api-linux src/index.ts
bun run deploy-binary.ts
```

`deploy-binary.ts` stops `cmms-api.service`, SFTPs the binary, swaps it in,
and restarts. Without `CMMS_SKIP_FULL_ETL` in `/etc/cmms-api.env`, every
restart runs a full ETL (~3 min on the 65K-row production DB) and rebuilds
the FTS5 index.

See [`AGENTS.md`](./AGENTS.md) for the full deploy story — server env, Lobe
Chat + Casdoor SSO stack, ports, and the hard-won image/env rules.

---

## 🧭 Architecture in one breath

```
                ┌────────────────────────────┐
   Technician ──▶│  Lobe Chat (3210)          │
   (VPN + LAN)   │  Casdoor SSO (8000)        │
                └──────────────┬─────────────┘
                               │  Bearer token
                ┌──────────────▼─────────────┐
                │  cmms-api binary (8787)    │
                │  POST /v1/chat/completions │
                │  ┌───────────────────────┐ │
                │  │ FTS5 (BM25) retrieval │ │
                │  │ → rag_chunks          │ │
                │  └───────────┬───────────┘ │
                │              ▼              │
                │  ┌───────────────────────┐ │
                │  │ Optional LLM rewrite  │ │
                │  │ (Kilo Gateway)        │ │
                │  └───────────┬───────────┘ │
                │              ▼              │
                │  ┌───────────────────────┐ │
                │  │ Grounding gate        │ │
                │  │ (reject bad citations)│ │
                │  └───────────────────────┘ │
                └──────────────┬─────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         cmms.db       cmms_specialized.db   fs watcher
       (history)        (integration)        (change → ETL → FTS5 rebuild)
```

---

## 🤝 Conventions

- **NY/Z polarity:** `NY/Z = 0` → closed (lezárt), `NY/Z = 1` → open (nyitott).
- **Hungarian data:** All ticket text, customer names, device IDs, and technician
  initials are in Hungarian. The LLM sees them as-is — no translation layer.
- **No server-side LLM required.** Without `KILO_API_KEY`, the endpoint returns
  a deterministic evidence-only answer (matched tickets with sorszam + snippet).
- **Grounding gate is non-negotiable.** Any LLM output citing a sorszam, customer,
  or date not present in the retrieved chunks (or the question) is rejected and
  the deterministic fallback ships instead. The endpoint never 500s on LLM failure.

---

## 🔌 The Ask-the-CMMS surface (Lobe Chat + Casdoor SSO)

The human-facing AI surface runs as a Docker stack on the same server
(`10.0.3.81`, LAN-only):

| Container | Purpose | Port |
|-----------|---------|------|
| `lobe-chat` | Lobe Chat UI (server-DB mode, Casdoor SSO) | 3210 |
| `lobe-casdoor` | OIDC IdP (org `nct`) | 8000 |
| `lobe-postgres` | PostgreSQL + pgvector (DBs `lobechat` + `casdoor`) | internal |

Technicians VPN into the LAN → open `http://10.0.3.81:3210` → Casdoor login
→ chat with the pre-wired `cmms` model. Zero provider setup.

Self-signup is enabled at `http://10.0.3.81:8000/signup/lobechat` (Username /
Display name / Password / Confirm); new users join org `nct` automatically.

See [`AGENTS.md`](./AGENTS.md) for the full env, the hard-won image/env rules,
and the Casdoor admin-password warning.

---

<div align="center">

**Built by NCT — for the technicians on the floor, with an LLM riding shotgun.**

<sub>🟣 purple power, 🐰 fast Bun, 🗄️ boring SQLite — exactly the right three.</sub>

</div>
