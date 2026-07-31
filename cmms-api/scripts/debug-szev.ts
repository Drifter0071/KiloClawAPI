import { parseCsv } from "../src/db/csv";
import { readFileSync } from "node:fs";

for (const y of [2019, 2020, 2021, 2022]) {
  const path = `C:/Users/garvangel/Documents/KiloClawAPI/newIntegrationCSVs/SZÉV IGÉNY - ${y}.csv`;
  const { header, rows } = parseCsv(readFileSync(path, "utf-8"));
  const idx = header.indexOf("szev_igeny_szam");
  const empty = rows.filter(r => !r[idx] || String(r[idx]).trim() === "").length;
  console.log(`year ${y}: header szev_igeny_szam idx=${idx} (col="${header[idx]}"), ${rows.length} rows, ${empty} have empty szev_szam`);
  // Show first 3 szev_szam values
  console.log("  first 3 szam:", rows.slice(0, 3).map(r => r[idx]));
}
