// Force a WAL checkpoint on the spec DB so the main file has all data.
import { Database } from "bun:sqlite";
const s = new Database("cmms_specialized.db");
s.exec("PRAGMA wal_checkpoint(TRUNCATE);");
const n = (s.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
console.log("jobs after checkpoint:", n);
s.close();
