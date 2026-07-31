import { parseCsv } from "../src/db/csv";
import { readFileSync } from "node:fs";
const path = "C:/Users/garvangel/Documents/KiloClawAPI/newIntegrationCSVs/Szervizlap belső - VS MEO 2.statisztika.csv";
const { header, rows } = parseCsv(readFileSync(path, "utf-8"));
console.log("header:", header);
console.log("first 5 rows (cells):");
for (let i = 0; i < 5; i++) console.log(" ", rows[i]);
