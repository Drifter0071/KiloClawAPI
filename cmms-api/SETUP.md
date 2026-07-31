# cmms-api — Debian setup + Cloudflare tunnel + kiloclaw connection guide

This document explains how to deploy `cmms-api` to a Debian Linux machine,
expose it to the internet over a Cloudflare tunnel, and have the
**kiloclaw** cloud agent connect to it.

`kiloclaw` is the cloud-hosted version of the OpenClaw AI assistant
framework. It runs on Kilo's infrastructure and reaches your `cmms-api`
over HTTPS, authenticates with a bearer token, and calls the endpoints
described in `/v1/capabilities`.

---

## 1. What you need on the Debian box

- Debian 12 (or 11) with `sudo` access.
- The CMMS database file (`cmms.db`, the same file the existing
  human-facing CMMS app reads).
- Outbound HTTPS to `github.com` (to install Bun), to
  `pkg.cloudflare.com` (for cloudflared), and to Cloudflare's relay
  network (the tunnel runs over port 7844).
- No inbound ports needed. No DNS records. No TLS certificates.
  The Cloudflare tunnel handles all three.

---

## 2. One-command install

Copy your build output and database to the Debian box, then run:

```bash
sudo CMMS_DB_PATH=/var/lib/cmms/cmms.db bash scripts/install.sh
```

The script generates two random tokens, writes them to
`/etc/cmms-api.env` (same `KEY=VALUE` format as `.env.example`), copies
the binary and database, starts the API on `127.0.0.1:8787`, and
launches a Cloudflare quick tunnel. It prints a `trycloudflare.com`
URL you can give directly to kiloclaw.

To override tokens or port, set them before running:

```bash
sudo CMMS_API_TOKEN_READ=my-custom-token PORT=9000 bash scripts/install.sh
```

The install script:

1. Creates a `cmmsapi` system user (no login shell, no home dir).
2. Installs Bun (if missing).
3. Copies the binary to `/opt/cmms-api/cmms-api`.
4. Copies `cmms.db` to `/var/lib/cmms/cmms.db` (if not already there).
5. Generates two random tokens, writes them to `/etc/cmms-api.env`
   (mode `0600`, owned by `cmmsapi`).
6. Installs and starts the `cmms-api.service` systemd unit.
7. Installs cloudflared (if missing).
8. Installs and starts the `cloudflared-cmms.service` systemd unit,
   which runs a quick tunnel to `http://127.0.0.1:8787`.
9. Waits for the tunnel URL to appear in the logs and prints it.

---

## 3. What kiloclaw needs from you

Hand the cloud agent (or its operator) exactly two values:

1. **Base URL** — the `trycloudflare.com` URL printed by the
   install script. This is the public HTTPS endpoint the agent will
   call. It changes every time `cloudflared-cmms` restarts; run
   `scripts/tunnel-url.sh` to get the current one.

2. **Read bearer token** — the value of `CMMS_API_TOKEN_READ` from
   `/etc/cmms-api.env`. The agent only needs the read token; never
   give it the write token unless you want it to log new jobs.

The agent's first call after connection should be:

```
GET {baseUrl}/v1/capabilities
Authorization: Bearer {readToken}
```

That endpoint returns the full API surface in one document (every
endpoint, every field, every example, the auth model, the conventions).
The agent can plan any subsequent operation from that response without
reading source code.

---

## 4. Retrieving the tunnel URL later

The URL is ephemeral. Each time the `cloudflared-cmms` service restarts
(a reboot, a crash, a `systemctl restart cloudflared-cmms`), a new URL
is assigned.

```bash
# print the current URL
scripts/tunnel-url.sh

# or read it from the logs
journalctl -u cloudflared-cmms.service -n 50 \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1

# or restart to get a new URL
sudo systemctl restart cloudflared-cmms
```

If the tunnel restarts, update the URL in kiloclaw's configuration.
The read token does not change.

---

## 5. How a typical kiloclaw session goes

1. Agent calls `GET /v1/capabilities` and learns the API.
2. Agent calls `GET /v1/index` to ground its answers in the real
   customer/model/technician distributions.
3. A human worker asks the agent "we have an NCT2000 with `képernyő
   sötét` (screen is dark) — how did we fix this last time?".
4. Agent calls
   `POST /v1/jobs/search` with `{ "q": "nct2000 kepernyo sotet" }`
   (diacritic-folded, lowercased). Returns past jobs with their
   `notes[kind=work]` showing what the technician actually did.
5. Agent summarizes the relevant `ELVÉGZETT MUNKA` notes for the
   worker.
6. If the agent has the write token, it can `POST /v1/jobs` to log
   the new job, or `POST /v1/jobs/:key/notes` with `kind="work"`
   once the fix is done.

---

## 6. Operational notes

- **Backups.** The API writes new jobs and notes both to `cmms.db` and
  to `cmms_specialized.db`. Back up both. The original `cmms.db` is
  the source of truth for the human CMMS app; `cmms_specialized.db`
  can always be rebuilt by deleting the file and restarting the service.
- **Logs.** JSON to `journalctl` (`journalctl -u cmms-api -f`). No
  PII beyond row content.
- **Rotating tokens.** Edit `/etc/cmms-api.env` and `sudo systemctl
  restart cmms-api`. The next `/v1/health` after restart shows the
  same job count. The file uses the same `KEY=VALUE` format as
  `.env.example`; Bun loads it from the working directory, systemd
  loads it via `EnvironmentFile`.
- **Updating the binary.** Stop the service, copy the new binary, start
  the service. The file watcher picks up any external changes to
  `cmms.db` and re-ETLs incrementally.
- **The ETL is slow on first start.** With the real ~200 MB `cmms.db`
  (~66,000 rows) on a small VPS, expect 1–3 minutes. The service is
  unavailable during that time. After that, incremental updates are
  sub-second.
- **Tunnel stability.** The quick tunnel (`trycloudflare.com`) is
  ephemeral. For a permanent URL, create a named tunnel at
  `dash.cloudflare.com` and run it with `cloudflared tunnel run`.
  Then update the `cloudflared-cmms.service` `ExecStart` to use the
  named tunnel instead of `--url`.

---

## 7. Troubleshooting

- `scripts/tunnel-url.sh` prints nothing: `cloudflared-cmms` has not
  started or has not connected yet. Check
  `journalctl -u cloudflared-cmms -f`.
- `curl` to the tunnel URL returns 401: token mismatch. Re-check the
  token in `/etc/cmms-api.env` and what the agent is sending.
- `/v1/capabilities` returns 503: `CMMS_API_TOKEN_WRITE` is not set.
  The server is in read-only mode. That is expected if you did not
  pass a write token at install time; the read endpoints still work.
- `journalctl -u cmms-api` shows `UNIQUE constraint failed:
  jobs.sorszam`: retry the `POST /v1/jobs`; the cache-based generator
  avoids this in practice.
- The cloud agent gets 404 on `/v1/capabilities`: the tunnel is not
  routing to the right port. Test locally first:
  `curl http://127.0.0.1:8787/v1/capabilities -H 'authorization: …'`
- Port 7844 blocked: cloudflared connects outbound to Cloudflare on
  TCP 7844. Open it in the firewall if needed.
