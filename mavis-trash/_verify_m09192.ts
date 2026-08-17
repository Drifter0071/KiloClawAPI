// Verify the M09192 fix against the live production service.
// Bun has built-in ssh2 support via the bun:ssh module? No — use child_process.
import { spawn } from "node:child_process";

const CMDS = [
  // 1) the answer endpoint (server-side router fix)
  `curl -s -X POST http://127.0.0.1:8787/v1/answer -H 'Authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89' -H 'Content-Type: application/json' -d '{"q":"X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál","language":"hu"}'`,
  // 2) one of the previously-broken integration tools (server-side curl simulating MCP server's GET-with-args path)
  `curl -s -X GET 'http://127.0.0.1:8787/v1/integration/serviz/search?q=M09192&limit=3' -H 'Authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89'`,
];

const sshArgs = [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "root@10.0.3.81",
  CMDS.join(" ; echo '---NEXT---' ; "),
];

const p = spawn("ssh", ["-tt", ...sshArgs], { stdio: ["ignore", "pipe", "pipe"] });

let out = "";
let err = "";
p.stdout.on("data", (d) => { out += d.toString(); });
p.stderr.on("data", (d) => { err += d.toString(); });
p.on("close", (code) => {
  console.log("exit:", code);
  console.log("STDOUT:", out.slice(0, 3500));
  console.log("STDERR:", err.slice(0, 500));
});
