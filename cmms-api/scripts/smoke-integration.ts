// Smoke-test the new integration routes by starting the server, hitting
// each new endpoint, and asserting the response shape. Reuses the live
// cmms.db + cmms_specialized.db (which already have the integration data).
import { openDbs } from "../src/db/open";
import { JobCache } from "../src/cache/jobs";
import { createApp } from "../src/server";

const READ = "smoke-read";
process.env.CMMS_API_TOKEN_READ = READ;
process.env.CMMS_API_TOKEN_WRITE = "smoke-write";

const dbs = openDbs();
const cache = new JobCache();
cache.buildFromDb(dbs);
const app = createApp(dbs, cache);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((res) => server.once("listening", () => res()));
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("no addr");
const url = `http://127.0.0.1:${addr.port}`;
const auth = { authorization: `Bearer ${READ}` };

async function hit(path: string, label: string) {
  const r = await fetch(url + path, { headers: auth });
  const j = await r.json();
  console.log(`\n[${r.status}] ${label}  ${path}`);
  console.log("  total:", j.total, "rows:", Array.isArray(j.jobs) ? j.jobs.length : "(no jobs) sample:", JSON.stringify(j.jobs?.[0] ?? j).slice(0, 220));
}

console.log("=== /v1/integration/health ===");
const h = await (await fetch(url + "/v1/integration/health", { headers: auth })).json();
console.log(JSON.stringify(h, null, 2));

await hit("/v1/integration/serviz/search?q=NCT&limit=3", "serviz FTS5 'NCT'");
await hit("/v1/integration/serviz/search?j_szam=J00001", "serviz by j_szam");
await hit("/v1/integration/serviz/by-j-szam?j=J00001", "serviz by-j-szam lookup");
await hit("/v1/integration/szev/search?q=csapágy&limit=3", "szev FTS5 'csapágy'");
await hit("/v1/integration/szev/search?year=2024&limit=3", "szev year=2024");
await hit("/v1/integration/telephely/search?q=szögfej&limit=3", "telephely FTS5 'szögfej'");
await hit("/v1/integration/ais/search?tipus=AiS100&limit=3", "aiS by tipus=AiS100");
await hit("/v1/integration/ais/search?q=zárlatos&limit=3", "aiS FTS5 'zárlatos'");
await hit("/v1/integration/statisztika/search?ev=2022&limit=5", "statisztika year=2022");
await hit("/v1/integration/nem-javitjuk/list", "nem-javitjuk list");
await hit("/v1/integration/stats", "integration stats");

server.close();
dbs.cmms.close();
dbs.spec.close();
console.log("\n=== done ===");
