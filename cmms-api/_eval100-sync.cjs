// _eval100-sync.cjs — run 100-question regression eval via SYNC REST API
// Works against the deployed server (old binary that only has /v1/answer-agent)
// Short questions: fast. Complex questions: may hit zrok ~60s timeout.
// Uses 'q' and 'language' (old binary format).
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://10.0.3.81:8787';
const TOKEN = 'b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89';
const QUESTIONS_FILE = path.join(__dirname, 'backup', 'probes-async-fix-2026-08-19', 'regression100-questions.json');
const OUT_FILE = path.join(__dirname, 'backup', 'probes-async-fix-2026-08-19', 'eval100-sync-results.jsonl');
const SUMMARY_FILE = path.join(__dirname, 'backup', 'probes-async-fix-2026-08-19', 'eval100-sync-summary.json');

function httpRequest(method, urlPath, body, timeoutMs = 95000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(body);
    req.end();
  });
}

async function askSync(question) {
  const t0 = Date.now();
  const { status, body } = await httpRequest('POST', '/v1/answer-agent', JSON.stringify({
    q: question,
    language: 'hu',
  }));

  const elapsed = Date.now() - t0;

  if (status !== 200) {
    return {
      error: `HTTP ${status}`,
      duration: elapsed,
      iterations: 0,
      soft_deadline_forced: null,
      model: null,
      final_len: 0,
    };
  }

  let data;
  try { data = JSON.parse(body); } catch { return { error: `Bad JSON: ${body.slice(0, 100)}`, duration: elapsed }; }

  if (data.error && !data.final_text) {
    return { error: data.error, duration: elapsed, iterations: 0, soft_deadline_forced: null, model: null, final_len: 0 };
  }

  return {
    duration: elapsed,
    iterations: data.iterations || 0,
    soft_deadline_forced: data.soft_deadline_forced ?? null,
    model: data.model || null,
    final_len: (data.final_text || '').length,
    answer_preview: (data.final_text || '').slice(0, 150),
    answer_id: data.answer_id || null,
  };
}

async function main() {
  console.log('Loading questions...');
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  console.log(`Got ${questions.length} questions`);
  console.log('WARNING: complex questions may hit zrok ~60s edge timeout — this is expected with old binary\n');

  const results = [];
  const start = Date.now();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const qStart = Date.now();

    let res;
    try {
      res = await askSync(q);
    } catch (e) {
      res = { error: e.message, duration: Date.now() - qStart };
    }

    res.q_num = i + 1;
    res.question = q;
    res.total_elapsed = Date.now() - start;
    results.push(res);

    if (res.error) {
      console.log(`[${i + 1}/100] TIMEOUT/ERROR (${res.duration}ms) — soft_deadline_forced=${res.soft_deadline_forced}: ${res.error}`);
    } else {
      const forced = res.soft_deadline_forced ? ' ⚠️ FORCED' : '';
      console.log(`[${i + 1}/100] OK (${res.duration}ms) iter=${res.iterations}${forced} model=${res.model} len=${res.final_len}`);
    }

    fs.appendFileSync(OUT_FILE, JSON.stringify(res) + '\n');
    await new Promise(r => setTimeout(r, 300));
  }

  const totalMs = Date.now() - start;
  const ok = results.filter(r => !r.error).length;
  const failed = results.filter(r => r.error).length;
  const durations = results.filter(r => !r.error).map(r => r.duration);
  const softForced = results.filter(r => r.soft_deadline_forced === true).length;
  const softNotForced = results.filter(r => r.soft_deadline_forced === false).length;
  const softNull = results.filter(r => r.soft_deadline_forced === null).length;
  const models = [...new Set(results.filter(r => r.model).map(r => r.model))];

  const summary = {
    total: 100,
    ok,
    failed,
    pct_ok: Math.round(ok * 100 / 100),
    total_ms: totalMs,
    avg_duration_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    median_duration_ms: durations.length ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)] : 0,
    max_duration_ms: durations.length ? Math.max(...durations) : 0,
    min_duration_ms: durations.length ? Math.min(...durations) : 0,
    soft_deadline_forced: softForced,
    soft_deadline_not_forced: softNotForced,
    soft_deadline_null: softNull,
    models_used: models,
    failed_questions: results.filter(r => r.error).map(r => ({
      q_num: r.q_num,
      question: r.question,
      error: r.error,
      duration_ms: r.duration,
    })),
    ok_questions: results.filter(r => !r.error).map(r => ({
      q_num: r.q_num,
      question: r.question.slice(0, 80),
      duration_ms: r.duration,
      final_len: r.final_len,
      iterations: r.iterations,
      soft_deadline_forced: r.soft_deadline_forced,
      model: r.model,
    })),
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  console.log('\n=== DONE ===');
  console.log(`OK: ${ok}/100 (${summary.pct_ok}%), Failed: ${failed}/100`);
  console.log(`Avg: ${summary.avg_duration_ms}ms, Median: ${summary.median_duration_ms}ms`);
  console.log(`Max: ${summary.max_duration_ms}ms, Min: ${summary.min_duration_ms}ms`);
  console.log(`soft_deadline_forced=true: ${softForced}`);
  console.log(`soft_deadline_forced=false: ${softNotForced}`);
  console.log(`soft_deadline_forced=null: ${softNull}`);
  console.log(`Models: ${models.join(', ')}`);
  console.log(`Total time: ${Math.round(totalMs / 60000)}min`);
  if (failed > 0) {
    console.log('\nFailed (timeout/error) questions:');
    summary.failed_questions.forEach(f => console.log(`  #${f.q_num} (${f.duration_ms}ms): ${f.error}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
