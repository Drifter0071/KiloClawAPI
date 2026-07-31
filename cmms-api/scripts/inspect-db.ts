import { Database } from "bun:sqlite";
const dbPath = process.argv[2] ?? "../cmms.db";
const d = new Database(dbPath, { readonly: true });
console.log("=== tables ===");
const tables = d.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
for (const t of tables) {
  const c = d.query("SELECT COUNT(*) AS n FROM \"" + t.name + "\"").get() as { n: number };
  console.log(`${t.name}: ${c.n} rows`);
}
console.log("=== indexes on data table ===");
const idx = d.query("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='data'").all() as { name: string; sql: string | null }[];
for (const i of idx) console.log(`${i.name}: ${i.sql ?? "(auto)"}`);
