// Retry pass: re-run the questions that failed in the first pass
// (connection refused during the deploy ETL). Appends retried results
// with a pass marker so the analysis can merge pass1+pass2.
// Run: bun regression100-retry.cjs
const fs = require("fs");
const path = require("path");

const DIR = "/tmp/regression100";
const OUTFILE = path.join(DIR, "results-retry.jsonl");
const LOGFILE = path.join(DIR, "retry.log");

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
  } catch { return ""; }
}

async function runOne(q) {
  const rec = { q };
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 320_000);
    const r = await fetch("http://127.0.0.1:8787/v1/answer-agent", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + readToken() },
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
      } catch { rec.parse_error = body.slice(0, 200); }
    } else {
      rec.error = body.slice(0, 300);
    }
  } catch (e) {
    rec.duration_s = Math.round((Date.now() - t0) / 1000);
    rec.error = String(e && e.message ? e.message : e);
  }
  return rec;
}

async function main() {
  // Load first-pass results, find the failed ones (no http field)
  const lines = fs.readFileSync(path.join(DIR, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean);
  const failed = [];
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.http === undefined || r.http !== 200) failed.push(r);
  }
  log(`pass1 records: ${lines.length}, to retry: ${failed.length}`);
  // ALSO read the original question order so n is preserved
  const questions = JSON.parse(fs.readFileSync(path.join(DIR, "questions.json"), "utf8"));

  const startedAt = Date.now();
  let done = 0, ok = 0;
  for (const rec of failed) {
    const out = await runOne(rec.q);
    out.n = rec.n;
    out.pass = 2;
    fs.appendFileSync(OUTFILE, JSON.stringify(out) + "\n");
    done++;
    if (out.http === 200) ok++;
    const el = Math.round((Date.now() - startedAt) / 1000);
    log(`[${done}/${failed.length}] #${out.n} http=${out.http ?? "-"} dur=${out.duration_s ?? "-"}s len=${out.final_len ?? "-"} it=${out.iterations ?? "-"} forced=${out.soft_deadline_forced ?? "-"} (elapsed ${el}s) :: ${out.q.slice(0, 60)}`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  const summary = { pass2_total: failed.length, pass2_ok: ok, elapsed_s: Math.round((Date.now() - startedAt) / 1000), generatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(DIR, "summary-retry.json"), JSON.stringify(summary, null, 2));
  log("=== RETRY DONE ===" + JSON.stringify(summary));
}

main().catch((e) => {
  log("FATAL: " + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
