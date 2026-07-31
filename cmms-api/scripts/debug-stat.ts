import { parseCsv } from "../src/db/csv";
import { readFileSync } from "node:fs";
const path = "C:/Users/garvangel/Documents/KiloClawAPI/newIntegrationCSVs/Szervizlap belső - VS MEO 2.statisztika.csv";
const { header, rows } = parseCsv(readFileSync(path, "utf-8"), {
  skipRows: 1,
  explicitHeader: ["kategoria", "hibas_db", "osszes_gyartott_db", "szazalek", "gar_db", "fiz_db"],
});
console.log("header:", header);
console.log("first 5 rows (col 0):");
for (let i = 0; i < 5; i++) console.log(" ", rows[i]?.[0]);
console.log("---");
// The first column has category names like "DxC hajtások". But the file
// also has a section divider "2022.01.14" used as a section header within
// the year 2022 (sub-dividing it). Let me see how many have that.
const yearLike = rows.filter(r => /^\d{4}\.\d{1,2}/.test(String(r[0] ?? "")));
console.log("rows where col 0 starts with YYYY.MM:", yearLike.length);
for (const r of yearLike.slice(0, 3)) console.log(" ", r.slice(0, 4));
