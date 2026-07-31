// Run both ETLs in sequence:
//   1. Original ETL: cmms.db `data` -> cmms_specialized.db (jobs/customers/notes/etc.)
//   2. Integration ETL: ./newIntegrationCSVs/*.csv -> cmms.db raw + cmms_specialized.db specialized
//
// Use this to set up a fresh cmms_specialized.db from a cmms.db + CSVs.
// Server startup runs both automatically when CMMS_INTEGRATION_CSV_DIR is set.

import { openDbs } from "../src/db/open";
import { runFullEtl } from "../src/db/etl";
import { runIntegration } from "../src/db/integration";
import { resolve, join } from "node:path";

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

console.log("=== 1. original ETL (cmms.db -> specialized.db) ===");
const dbs = openDbs({ cmmsPath: cmmsPath, specializedPath: specPath });
const r1 = runFullEtl(dbs);
console.log(`  ${r1.rows} rows, ${r1.devices} devices, ${r1.notes} notes in ${r1.durationMs}ms`);
dbs.cmms.close();
dbs.spec.close();

console.log("\n=== 2. integration ETL (CSVs -> cmms.db raw + specialized.db) ===");
const r2 = runIntegration({ cmmsDbPath: cmmsPath, specDbPath: specPath, csvDir });
console.log(`  ${r2.files} files, ${r2.totalRows} rows in ${r2.durationMs}ms`);
if (r2.errors.length) {
  console.log("  errors:");
  for (const e of r2.errors) console.log(`    - ${e}`);
}
