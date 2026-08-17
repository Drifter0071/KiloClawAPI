// Verify: with the guard live, what does the MCP server return for
// "M09192" + prose through the integration tool? (Where the LLM
// would have hit M11357/M06079 before.)
import { spawn } from "node:child_process";

const ssh = spawn("ssh", [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "root@10.0.3.81",
  `curl -s -X GET 'http://127.0.0.1:8787/v1/integration/serviz/search?q=M09192&limit=3' -H 'Authorization: Bearer b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89' | head -c 800`,
], { stdio: ["ignore", "pipe", "pipe"] });

let out = "";
ssh.stdout.on("data", (d) => { out += d.toString(); });
ssh.stderr.on("data", (d) => { out += "STDERR:" + d.toString(); });
ssh.on("close", (code) => {
  console.log("exit:", code);
  console.log(out);
});
