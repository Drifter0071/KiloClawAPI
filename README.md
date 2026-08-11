<div align="center">

# 🟣 NCT Claw API

**A Bun + SQLite service that puts your CMMS data in front of an AI agent — safely, fast, and with a real MCP surface.**

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
CMMS. It serves a `cmms.db` SQLite archive of past service jobs to an AI agent
("kiloclaw") over HTTPS, so on-the-ground technicians can ask the agent
*"what did we do last time this DPB-2 broke at ANDRITZ?"* and get a real answer
in seconds.

The same server also exposes a full **MCP (Model Context Protocol)** surface —
27 tools, bilingual EN/HU, deterministic keyword router, server-side period
filtering — so the agent gets reproducible answers, not vibes.

---

## 🚀 Features

| | |
|---|---|
| 🟣 **MCP-native** | 27 tools, `answer_question` router, bilingual descriptions, server-side date filters |
| ⚡ **Bun-powered** | Single self-contained Linux binary, no Node.js runtime on the server |
| 🗄️ **SQLite on disk** | Two DBs — `cmms.db` (history) and `cmms_specialized.db` (integration data) |
| 🔐 **Bearer-token auth** | Read token and write token, rotated independently |
| 🔄 **Live ETL** | File watcher re-ingests when the CSV is dropped in |
| 🧠 **Inferred fields** | `kategoria` / `severity` auto-classified with confidence, backfill-gated |
| 🌍 **Cross-database** | One `find_related_tickets` call spans CMMS, serviz_belso, szev_igeny, telephely_munka |
| 🧪 **264 tests** | Unit + integration + a 100-question regression catalog |

---

## 📦 What's in the box

```
KiloClawAPI/
├── cmms-api/                 # The service
│   ├── src/                  # TypeScript source
│   │   ├── db/               # SQLite connections, ETL, device parser
│   │   ├── cache/            # In-memory JobCard cache
│   │   ├── routes/           # /v1/health, /v1/jobs/*, /v1/answer, /v1/related
│   │   ├── lib/              # router, classifier, related, cluster
│   │   ├── schema/schema.json
│   │   ├── server.ts         # express app factory
│   │   └── index.ts          # bootstrap
│   ├── mcp-server.ts         # MCP HTTP server (port 8788)
│   ├── tests/                # bun test suite, 264 tests
│   └── deploy-*.ts           # production deploy scripts
├── docs/                     # design docs
├── newIntegrationCSVs/       # source data for the specialized DB
├── AGENTS.md                 # agent operating manual
└── tunnel-info.txt           # current public URL + tokens
```

---

## ⚙️ Quick start

```bash
cd cmms-api
bun install
cp .env.example .env       # fill in tokens + CMMS_DB_PATH
bun run src/index.ts
```

That's it. Health check on `http://127.0.0.1:8787/v1/health`.

## 🧪 Test

```bash
cd cmms-api
bun test                   # 264 tests, 0 failures, 1501 expects
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

See [`cmms-api/AGENTS.md`](./cmms-api/AGENTS.md) (also mirrored as the repo-root
`AGENTS.md`) for the full deploy story — three services, one zrok tunnel,
no cloudflared, and a backfill-gated DB migration on first restart.

---

## 🛠️ The MCP surface (27 tools, v0.5.0)

| # | Tool | What it does |
|---|---|---|
| 0 | `answer_question` | **Primary.** Keyword router — passes the user's question straight through. |
| 1 | `search_tickets` | Unified search with auto-extracted customer / device / sorszam / period. |
| 2 | `search_existing_tickets` | Free-text + filter search. |
| 3 | `get_ticket_stats` | Aggregations by customer / device / category / severity / month. |
| 4 | `find_recurring_problems` | Clusters of 2+ tickets sharing a root-cause signature. |
| 5 | `get_problem_cluster` | Drill into one cluster. |
| 6 | `search_serviz_belso` | Internal szerviz archive (2008 → now). |
| 7 | `get_serviz_ticket` | Single internal ticket by J-sorszam. |
| 8 | `search_szev_igeny` | Internal material / service requisitions (2019 → now). |
| 9 | `search_telephely_munka` | In-house workshop jobs. |
| 10 | `search_ais_motor_inventory` | The bad-AiS-motor stock. |
| 11 | `get_integration_stats` | Cross-DB aggregates. |
| 12 | `get_failure_rates` | Per-model failure rates from `statisztika`. |
| 13 | `find_spare_motor` | Replacement motor lookup with `match_score`. |
| 14 | `search_customers` | Substring search + per-customer ticket counts. |
| 15 | `customer_canonical` | Folds alias variants of the same real customer. |
| 16 | `find_related_tickets` | Cross-database timeline across all 4 archives. |
| 17–26 | `create_ticket`, `modify_ticket`, `close_ticket`, `remove_ticket`, `get_categories`, `get_tags`, `add_ticket_tag`, `set_ticket_category`, `set_ticket_severity`, `search_by_category` | Mutations + meta. |

All search / stats tools accept a bilingual `period`:
`this_month`, `last_year`, `last_30_days`, `YTD`, `all`, `custom`,
or in Hungarian: `ma`, `tavaly`, `idén`, `utolsó 30 nap`, `múlt hónap`, `minden`.

The response always echoes the resolved `date_from` / `date_to` so the
calling model can cite the exact window it used.

---

## 🧭 Architecture in one breath

```
                ┌────────────────────────────┐
   AI agent ──▶ │  zrok tunnel (public)      │
   (kiloclaw)   │  https://nctmechanic.../mcp│
                └──────────────┬─────────────┘
                               │  HTTPS + bearer
                ┌──────────────▼─────────────┐
                │  mcp-server.ts  (8788)     │   ← 27 tools, EN/HU
                │  src/routes/answer.ts      │   ← answer_question router
                └──────────────┬─────────────┘
                               │
                ┌──────────────▼─────────────┐
                │  cmms-api binary  (8787)   │   ← REST + auth + ETL
                │  src/cache/jobs.ts         │   ← in-memory JobCard cache
                └──────────────┬─────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         cmms.db       cmms_specialized.db   fs watcher
       (history)        (integration)        (CSV in → ETL)
```

---

## 🤝 Conventions

- **NY/Z polarity:** `NY/Z = 0` → closed (lezárt), `NY/Z = 1` → open (nyitott).
- **Inferred vs human columns:** `kategoria_inferred`, `sulyossag_inferred`,
  `alkategoria_inferred` never overwrite their human counterparts.
- **Backfills are gated** by `_meta` flags — first restart runs them, every
  restart after is a no-op.
- **No server-side LLM.** The router is pure keyword + decision tree —
  deterministic, reproducible, free.

---

<div align="center">

**Built by NCT — for the technicians on the floor, with an LLM riding shotgun.**

<sub>🟣 purple power, 🐰 fast Bun, 🗄️ boring SQLite — exactly the right three.</sub>

</div>
