// Minimal client the kiloclaw agent can use to talk to cmms-api.
// Run with:  bun examples/client.ts
//
// The agent is expected to call GET /v1/capabilities first (see
// /src/routes/capabilities.ts for the full surface) and then act on
// whatever it learned. This file is a copy-pasteable reference, not a
// SDK to ship.

const BASE = process.env.CMMS_API_URL ?? "http://127.0.0.1:8787";
const READ = process.env.CMMS_API_TOKEN_READ ?? "";
const WRITE = process.env.CMMS_API_TOKEN_WRITE ?? "";

type FetchOpts = { method?: string; body?: unknown; token?: string };

async function call<T = any>(path: string, opts: FetchOpts = {}): Promise<T> {
  const token = opts.token ?? READ;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function main() {
  // 1. learn the API.
  const caps = await call<{ server: { name: string }; endpoints: { method: string; path: string }[] }>("/v1/capabilities");
  console.log("connected to", caps.server.name, "with", caps.endpoints.length, "endpoints");

  // 2. ground: what customers, models, technicians exist?
  const idx = await call<{ topCustomers: { name: string; count: number }[]; totalJobs: number }>("/v1/index");
  console.log("total jobs:", idx.totalJobs);
  console.log("top 3 customers:", idx.topCustomers.slice(0, 3).map((c) => c.name));

  // 3. example: a worker asks about a fault on an NCT2000.
  // The agent folds diacritics and lowercases for the agent-side query.
  const search = await call<{ total: number; jobs: any[] }>("/v1/jobs/search", {
    method: "POST",
    body: { q: "nct2000 kepernyo sotet", limit: 5 },
  });
  console.log("matches:", search.total);
  for (const j of search.jobs) {
    const work = j.notes.find((n: any) => n.kind === "work");
    console.log(`  ${j.sorszam} ${j.customer.name}: ${work?.body ?? "(no work note)"}`);
  }

  // 4. example: the agent decides to log a new job (requires write token).
  if (WRITE) {
    const created = await call<{ key: number; sorszam: string }>("/v1/jobs", {
      method: "POST",
      token: WRITE,
      body: {
        customer: { name: "DEMO CUST" },
        devices: ["NCT2000"],
        reported: "screen is dark",
        technician: "AGENT",
      },
    });
    console.log("logged new job:", created);

    // 5. append a work note once the fix is done.
    await call(`/v1/jobs/${created.key}/notes`, {
      method: "POST",
      token: WRITE,
      body: { kind: "work", body: "replaced backlight inverter", author: "AGENT" },
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
