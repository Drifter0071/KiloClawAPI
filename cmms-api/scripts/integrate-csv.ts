// Driver: build the integration tables in cmms.db (raw) and
// cmms_specialized.db (normalized + FTS). Idempotent.
//
//   bun run scripts/integrate-csv.ts                        # default paths
//   bun run scripts/integrate-csv.ts --cmms=... --spec=... # override
//
// Default paths: ../cmms.db, ./cmms_specialized.db (resolved relative to repo root).

import { runIntegration } from "../src/db/integration";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const cmmsPath = resolve(arg("--cmms", join(REPO, "cmms.db")));
const specPath = resolve(arg("--spec", join(REPO, "cmms-api", "cmms_specialized.db")));
const csvDir   = resolve(arg("--csv",  join(REPO, "newIntegrationCSVs")));

console.log(`cmms db : ${cmmsPath}`);
console.log(`spec db : ${specPath}`);
console.log(`csv dir : ${csvDir}`);
console.log("");

const r = runIntegration({ cmmsDbPath: cmmsPath, specDbPath: specPath, csvDir });

console.log("");
console.log("============================================================");
console.log(`Integration done in ${r.durationMs} ms`);
console.log(`  files loaded: ${r.files}`);
console.log(`  total rows  : ${r.totalRows}`);
console.log("");
console.log("  per-table row counts:");
const keys = Object.keys(r.byTable).sort();
for (const k of keys) console.log(`    ${k.padEnd(28)} ${r.byTable[k]}`);
if (r.errors.length) {
  console.log("");
  console.log("  errors:");
  for (const e of r.errors) console.log(`    - ${e}`);
}
