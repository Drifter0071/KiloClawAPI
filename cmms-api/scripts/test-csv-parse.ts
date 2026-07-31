// Self-test for src/db/csv.ts. Run with: bun run scripts/test-csv-parse.ts
import { parseCsv, normalizeDate, normalizeNumber, normalizeBool } from "../src/db/csv";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "newIntegrationCSVs");
const samples = [
  "Szervizlap belső - SZERVIZLAP BELSŐ 2008-2020.csv",
  "SZÉV IGÉNY - 2024.csv",
  "Telephelyi munkák - TH javítások adat .csv",
  "Telephelyi munkák - 2018.csv",
  "Szervizlap belső - SZERVIZLAP BELSŐ 2020- TAKSONY.csv",
  "Szervizlap belső - VS MEO 2.statisztika.csv",
  "Szervizlap belső - Nem javítjuk.csv",
  "Telephelyi munkák - AiS100.csv",
];

for (const f of samples) {
  const path = join(root, f);
  const text = readFileSync(path, "utf-8");
  const { header, rows } = parseCsv(text);
  console.log(`\n=== ${f} ===`);
  console.log(`header (${header.length}):`, header.slice(0, 20).join(" | "));
  console.log(`rows: ${rows.length}`);
  if (rows.length > 0) {
    console.log(`first row:`, rows[0].slice(0, 20));
    if (rows.length > 1) console.log(`second row:`, rows[1].slice(0, 20));
  }
}

console.log("\n=== date normalizer sanity ===");
const dates = ["2008/06/18", "2014/11/28", "2024.05.24.", "2026-07-02", "01.08.2024", "2022", "", "garbage"];
for (const d of dates) console.log(`${JSON.stringify(d).padEnd(20)} -> ${normalizeDate(d)}`);

console.log("\n=== number normalizer ===");
const nums = ["1,00", "12,08%", "654", "12,5", "0", "0,5", ""];
for (const n of nums) console.log(`${JSON.stringify(n).padEnd(10)} -> ${normalizeNumber(n)}`);

console.log("\n=== bool normalizer ===");
const bools = ["TRUE", "FALSE", "igen", "1", "0", ""];
for (const b of bools) console.log(`${JSON.stringify(b).padEnd(8)} -> ${normalizeBool(b)}`);
