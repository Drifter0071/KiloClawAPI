import { Database } from "bun:sqlite";
const d = new Database("cmms_specialized.db", { readonly: true });
const t = d.query("SELECT sql FROM sqlite_master WHERE name=?").get("jobs") as { sql: string } | undefined;
console.log("jobs schema:", t?.sql);
const cols = d.query("PRAGMA table_info(jobs)").all();
for (const c of cols as any[]) console.log("  col:", c.name, c.type);
