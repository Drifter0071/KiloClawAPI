// Regression-100 eval runner — runs ON the server (10.0.3.81).
// For each catalog question: POST /v1/answer-agent with NO time limit
// (softDeadlineMs: 0, timeoutMs: 300000) — the same agent behavior the
// dashboard now gets. Records result + timing to a JSONL file.
// Run: bun regression100-runner.cjs
const fs = require("fs");
const path = require("path");

const DIR = "/tmp/regression100";
const QFILE = path.join(DIR, "questions.json");
const OUTFILE = path.join(DIR, "results.jsonl");
const LOGFILE = path.join(DIR, "runner.log");

function log(...args) {
  const line = new Date().toISOString() + " " + args.join(" ");
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + "\n"); } catch {}
}

function readToken() {
  try {
    const env = fs.readFileSync("/etc/cmms-api.env", "utf8");
    const m = env.match(/^CMMS_API_TOKEN_READ=(.+)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const questions = JSON.parse(fs.readFileSync(QFILE, "utf8"));
  const token = readToken();
  log(`token: ${token ? "ok (" + token.slice(0, 8) + "...)" : "MISSING"}`);
  log(`questions: ${questions.length}`);

  let done = 0, ok = 0, failed = 0, timedOut = 0;
  const startedAt = Date.now();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const rec = { n: i + 1, q };
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 320_000); // 300s agent + margin
      const r = await fetch("http://127.0.0.1:8787/v1/answer-agent", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ q, language: "hu", softDeadlineMs: 0, timeoutMs: 300_000 }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      rec.http = r.status;
      const body = await r.text();
      rec.duration_s = Math.round((Date.now() - t0) / 1000);
      if (r.status === 200) {
        try {
          const j = JSON.parse(body);
          rec.iterations = j.iterations;
          rec.final_len = j.final_text ? j.final_text.length : 0;
          rec.soft_deadline_forced = j.soft_deadline_forced;
          rec.model = j.model;
          rec.tool_trace = (j.tool_trace || []).map((s) => s.name);
          rec.has_answer = typeof j.final_text === "string" && j.final_text.trim().length > 0;
          ok++;
        } catch {
          rec.parse_error = body.slice(0, 200);
          failed++;
        }
      } else {
        rec.error = body.slice(0, 300);
        failed++;
      }
    } catch (e) {
      rec.duration_s = Math.round((Date.now() - t0) / 1000);
      rec.error = String(e && e.message ? e.message : e);
      timedOut++;
      failed++;
    }
    done++;
    fs.appendFileSync(OUTFILE, JSON.stringify(rec) + "\n");
    const el = Math.round((Date.now() - startedAt) / 1000);
    log(`[${done}/${questions.length}] #${rec.n} http=${rec.http ?? "-"} dur=${rec.duration_s ?? "-"}s len=${rec.final_len ?? "-"} it=${rec.iterations ?? "-"} forced=${rec.soft_deadline_forced ?? "-"} (elapsed ${el}s) :: ${q.slice(0, 70)}`);
    // Gentle pause between runs (the agent loop is CPU/IO heavy).
    await new Promise((res) => setTimeout(res, 1500));
  }

  const summary = {
    total: questions.length,
    ok,
    failed,
    timedOut,
    elapsed_s: Math.round((Date.now() - startedAt) / 1000),
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DIR, "summary.json"), JSON.stringify(summary, null, 2));
  log("=== DONE ===" + JSON.stringify(summary));
}

main().catch((e) => {
  log("FATAL: " + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
