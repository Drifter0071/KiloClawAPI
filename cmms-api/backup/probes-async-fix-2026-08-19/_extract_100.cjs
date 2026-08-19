// Extract the 100 catalog questions from tests/15-regression-100.test.ts
const fs = require("fs");
const src = fs.readFileSync("tests/15-regression-100.test.ts", "utf8");
const qs = [];
// q: '...'  or  q: "..."  (single line values)
const re = /q:\s*(["'])(.*?)\1/g;
let m;
while ((m = re.exec(src)) !== null) qs.push(m[2]);
console.log("count:", qs.length);
const seen = new Set();
let dupes = 0;
for (const q of qs) {
  if (seen.has(q)) dupes++;
  seen.add(q);
}
console.log("dupes:", dupes);
// Write as JSON lines for the runner
fs.writeFileSync("backup/probes-async-fix-2026-08-19/regression100-questions.json", JSON.stringify(qs, null, 2), "utf8");
console.log("saved backup/probes-async-fix-2026-08-19/regression100-questions.json");
// Also print the first 5 + last 2 for sanity
for (const q of qs.slice(0, 5)) console.log("  -", q);
console.log("  ...");
for (const q of qs.slice(-2)) console.log("  -", q);
