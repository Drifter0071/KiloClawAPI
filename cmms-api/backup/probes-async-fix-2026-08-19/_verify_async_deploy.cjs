// Verify: cmms-api up + async endpoints exist on 10.0.3.81.
// Run: bun _verify_async_deploy.cjs
const { Client } = require("ssh2");
const fs = require("fs");

const HOST = "10.0.3.81";
const USER = "root";
const PASS = "tarantula999";

function ssh(cmd) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = "";
        let errOut = "";
        stream.on("close", (code) => {
          conn.end();
          resolve({ code, stdout: out, stderr: errOut });
        });
        stream.on("data", (d) => (out += d.toString()));
        stream.stderr.on("data", (d) => (errOut += d.toString()));
      });
    });
    conn.on("error", reject);
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS });
  });
}

async function main() {
  const health = await ssh("curl -fsS http://127.0.0.1:8787/v1/health 2>/dev/null || echo DOWN");
  console.log("health:", health.stdout.trim().slice(0, 200));

  const tok = await ssh("grep ^CMMS_API_TOKEN_READ= /etc/cmms-api.env | cut -d= -f2");
  const token = tok.stdout.trim();

  // Async POST: expect 202 + job_id (LLM key present? check env)
  const key = await ssh("grep -c ^KILO_API_KEY= /etc/cmms-api.env || true");
  console.log("KILO_API_KEY present:", key.stdout.trim());

  const post = await ssh(
    `curl -sS -o /tmp/async_probe.json -w '%{http_code}' -X POST http://127.0.0.1:8787/v1/answer-agent/async ` +
      `-H "Authorization: Bearer ${token}" -H "content-type: application/json" ` +
      `-d '{"q":"Mi a legutóbbi munka az M17191 gépen?","language":"hu"}'`
  );
  console.log("async POST http:", post.stdout.trim());
  const body = await ssh("cat /tmp/async_probe.json 2>/dev/null");
  console.log("async POST body:", body.stdout.trim().slice(0, 300));

  // Poll the job once (may still be running)
  const jobId = (body.stdout.match(/"job_id":"([^"]+)"/) || [])[1];
  if (jobId) {
    const poll = await ssh(
      `curl -fsS http://127.0.0.1:8787/v1/answer-agent/async/${jobId} -H "Authorization: Bearer ${token}"`
    );
    console.log("async GET:", poll.stdout.trim().slice(0, 300));
  }
  // 404 probe
  const nf = await ssh(
    `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/v1/answer-agent/async/00000000-0000-0000-0000-000000000000 -H "Authorization: Bearer ${token}"`
  );
  console.log("unknown job http:", nf.stdout.trim());
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
