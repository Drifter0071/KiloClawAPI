import { Database } from "bun:sqlite";
const s = new Database("cmms_specialized.db", { readonly: true });
const tables = ["jobs", "devices", "customers", "notes", "serviz_belso", "szev_igeny", "telephely_munka", "telephely_ais_motor", "statisztika", "nem_javitjuk", "problema_kategoriak"];
for (const t of tables) {
  const n = (s.query("SELECT COUNT(*) AS n FROM " + t).get() as { n: number }).n;
  console.log(t.padEnd(25), n);
}
