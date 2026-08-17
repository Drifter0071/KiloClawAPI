// Direct check: is M09192 in the main CMMS DB? Is the router fix live?
import { spawn } from "node:child_process";

const ssh = spawn("ssh", [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "root@10.0.3.81",
  `echo "=== M09192 in main cmms.db ===" && sqlite3 /var/lib/cmms/cmms.db "SELECT sorszam, status, customer, problem_kategoria, devices, reported_at FROM jobs WHERE sorszam LIKE '%09192%' OR devices LIKE '%M09192%' LIMIT 5" && echo "=== router fix: /v1/answer for M09192 + prose ===" && curl -s -X POST http://127.0.0.1:8787/v1/answer -H 'Authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89' -H 'Content-Type: application/json' -d '{"q":"X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál","language":"hu"}' | head -c 1500`,
], { stdio: ["ignore", "pipe", "pipe"] });

let out = "";
ssh.stdout.on("data", (d) => { out += d.toString(); });
ssh.stderr.on("data", (d) => { out += "STDERR:" + d.toString(); });
ssh.on("close", (code) => {
  console.log("exit:", code);
  console.log(out);
});
