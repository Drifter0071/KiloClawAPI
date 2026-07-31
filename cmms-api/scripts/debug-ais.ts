import { Database } from "bun:sqlite";
const spec = new Database("cmms_specialized.db", { readonly: true });
for (const r of spec.query("SELECT sorszam, tipus, problema, source_file FROM telephely_ais_motor WHERE tipus IS NULL OR tipus LIKE 'Típus%' OR tipus LIKE 'Tipus%'").all()) {
  console.log(r);
}
