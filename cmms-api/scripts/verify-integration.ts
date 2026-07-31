// Quick verification of the specialized DB content + FTS.
import { Database } from "bun:sqlite";

const spec = new Database("cmms_specialized.db", { readonly: true });

function rowCount(sql: string): number {
  return (spec.query(sql).get() as { n: number }).n;
}

console.log("=== table sizes ===");
const tables = ["serviz_belso", "szev_igeny", "telephely_munka", "telephely_ais_motor", "nem_javitjuk", "statisztika"];
for (const t of tables) console.log(`  ${t.padEnd(25)} ${rowCount(`SELECT COUNT(*) AS n FROM ${t}`)}`);

console.log("\n=== FTS sanity (serviz_belso_fts) ===");
const fts1 = spec.query(
  `SELECT s.j_szam, s.cegnev, s.eszkoz, s.hibajelenseg
   FROM serviz_belso_fts f
   JOIN serviz_belso s ON s.id = f.rowid
   WHERE serviz_belso_fts MATCH 'NCT'
   LIMIT 5`,
).all();
for (const r of fts1 as any[]) console.log("  ", r.j_szam, "|", r.cegnev, "|", r.eszkoz, "|", r.hibajelenseg?.slice(0, 60));

console.log("\n=== FTS sanity (szev_igeny_fts) — looking for 'csapágy' ===");
const fts2 = spec.query(
  `SELECT s.szev_szam, s.megrendelo, s.igeny
   FROM szev_igeny_fts f
   JOIN szev_igeny s ON s.id = f.rowid
   WHERE szev_igeny_fts MATCH 'csapágy'
   LIMIT 5`,
).all();
for (const r of fts2 as any[]) console.log("  ", r.szev_szam, "|", r.megrendelo, "|", r.igeny?.slice(0, 60));

console.log("\n=== FTS sanity (telephely_munka_fts) — looking for 'szögfej' ===");
const fts3 = spec.query(
  `SELECT s.munkaszam, s.megrendelo, s.geptipus, s.hibajelenseg
   FROM telephely_munka_fts f
   JOIN telephely_munka s ON s.id = f.rowid
   WHERE telephely_munka_fts MATCH 'szögfej'
   LIMIT 5`,
).all();
for (const r of fts3 as any[]) console.log("  ", r.munkaszam, "|", r.megrendelo, "|", r.geptipus, "|", r.hibajelenseg?.slice(0, 50));

console.log("\n=== ai motor inventory (52 of 53 should be AiS100 or AiS132) ===");
const types = spec.query(
  `SELECT tipus, COUNT(*) AS n FROM telephely_ais_motor GROUP BY tipus ORDER BY n DESC`,
).all();
for (const r of types as any[]) console.log("  ", r.tipus, "→", r.n);

console.log("\n=== statisztika — DxC hajtások rows ===");
const stat = spec.query(
  `SELECT ev, kategoria, hibas_db, ossz_gyartott_db, szazalek FROM statisztika
   WHERE kategoria_ascii LIKE 'dxc%' LIMIT 10`,
).all();
for (const r of stat as any[]) console.log("  ", r);

console.log("\n=== year distribution of szev_igeny ===");
const byYear = spec.query(
  `SELECT year, COUNT(*) AS n FROM szev_igeny GROUP BY year ORDER BY year`,
).all();
for (const r of byYear as any[]) console.log("  ", r.year, "→", r.n);

console.log("\n=== source_periods in serviz_belso ===");
const periods = spec.query(
  `SELECT source_period, COUNT(*) AS n FROM serviz_belso GROUP BY source_period`,
).all();
for (const r of periods as any[]) console.log("  ", r.source_period?.slice(0, 60), "→", r.n);

console.log("\n=== cmms.db raw tables ===");
const cmms = new Database("../cmms.db", { readonly: true });
const cmmsTables = cmms.query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_v_%' ORDER BY name",
).all() as { name: string }[];
for (const t of cmmsTables) {
  const c = (cmms.query(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n;
  console.log(`  ${t.name.padEnd(30)} ${c}`);
}
