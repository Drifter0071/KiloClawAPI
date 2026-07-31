# cmms-api

A small Bun + Express + SQLite service that exposes a CMMS database
(`cmms.db`) to a cloud AI agent ("kiloclaw") over HTTPS. The agent
reads past jobs to help on-the-ground workers fix issues, and can
append new jobs and notes.

## What is in this directory

```
src/                # source
  db/               # SQLite connections, ETL, device parser, sorszam
  cache/            # in-memory JobCard cache
  routes/           # /v1/health, /v1/capabilities, /v1/schema,
                    # /v1/index, /v1/jobs/*, auth middleware
  schema/schema.json
  server.ts         # express app factory (used by tests and by index.ts)
  index.ts          # bootstrap (open DBs, ETL, file watcher, listen)

tests/              # bun test suite
  fixtures/         # temp cmms.db builder for tests
  01-meta.test.ts   # /v1/health, /v1/capabilities, /v1/schema, /v1/index
  02-jobs-read.test.ts  # auth, search, get, get-raw
  03-jobs-write.test.ts # create job, append note, mirror to cmms.db
  04-parse.test.ts  # unit tests for the device parser + diacritic fold
  harness.ts        # spins up a fresh app per test file

examples/
  client.ts         # minimal client the agent can copy

scripts/
  build.sh          # compile to a single self-contained binary
  install.sh        # Debian provisioning: systemd unit, user, env file,
                    # cloudflared quick tunnel, prints tunnel URL + tokens
  tunnel-url.sh     # print the current trycloudflare.com URL
  healthcheck.sh    # cron-friendly liveness probe + restart

SETUP.md            # full Debian deployment + kiloclaw connection guide
```

## First contact for the AI agent

`GET /v1/capabilities` returns the entire API surface in one document:
every endpoint, every request and response field, the auth model,
conventions, and copy-pasteable examples. The agent should call this
once on connection. See `src/routes/capabilities.ts`.

## Run locally

```bash
bun install
cp .env.example .env
# edit .env — fill in tokens and CMMS_DB_PATH
bun run src/index.ts
```

Bun loads `.env` from the working directory automatically.

## Test

```bash
bun test
```

The suite spins up a fresh server per test file with a temp cmms.db,
runs the full ETL, and exercises every endpoint plus the device parser.
It does **not** touch the real `cmms.db`.

## Build the binary

```bash
bun run build          # Debian x64 target by default
BUILD_TARGET=local bun run build   # current OS (for dev)
```

## Deploy

See [SETUP.md](./SETUP.md) for the full Debian + Cloudflare tunnel
guide. Quick version:

```bash
sudo bash scripts/install.sh
```

The script generates tokens, writes `/etc/cmms-api.env` (same format
as `.env.example`), starts the API and a Cloudflare tunnel, and
prints the tunnel URL + read token to hand to kiloclaw.
