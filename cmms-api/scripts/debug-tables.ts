import { Database } from "bun:sqlite";
const s = new Database("cmms_specialized.db", { readonly: true });
const tables = s.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
for (const t of tables) {
  const n = (s.query(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n;
  console.log(t.name.padEnd(30), n);
}
