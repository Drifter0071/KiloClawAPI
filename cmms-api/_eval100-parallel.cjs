// _eval100-parallel.cjs — 100 questions in parallel batches of 10
// Each batch: Promise.all(10 questions), ~20-30s per batch → ~5min total
// Continues from existing eval100-sync-results.jsonl (appends only new questions)
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
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(body);
    req.end();
  });
}

async function askSync(question) {
  const t0 = Date.now();
  let data;
  try {
    const { status, body } = await httpRequest('POST', '/v1/answer-agent', JSON.stringify({ q: question, language: 'hu' }));
    const elapsed = Date.now() - t0;
    if (status !== 200) return { error: `HTTP ${status}`, duration: elapsed };
    data = JSON.parse(body);
    if (data.error && !data.final_text) return { error: data.error, duration: elapsed };
    return {
      duration: elapsed,
      iterations: data.iterations || 0,
      soft_deadline_forced: data.soft_deadline_forced ?? null,
      model: data.model || null,
      final_len: (data.final_text || '').length,
      answer_preview: (data.final_text || '').slice(0, 100),
      answer_id: data.answer_id || null,
    };
  } catch (e) {
    return { error: e.message, duration: Date.now() - t0 };
  }
}

async function main() {
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  const existingLines = (fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8').trim().split('\n') : []);
  const existingNums = new Set(existingLines.map(l => parseInt(JSON.parse(l).q_num)));
  const pending = questions.map((q, i) => ({ q_num: i + 1, question: q })).filter(x => !existingNums.has(x.q_num));

  console.log(`Total: 100, Already done: ${existingNums.size}, Remaining: ${pending.length}`);

  const BATCH = 10;
  const allResults = [...existingLines.map(l => JSON.parse(l))];
  const start = Date.now();

  for (let b = 0; b < pending.length; b += BATCH) {
    const batch = pending.slice(b, b + BATCH);
    const batchNums = batch.map(x => x.q_num);
    const t0 = Date.now();
    process.stdout.write(`Batch ${Math.floor(b / BATCH) + 1}/${Math.ceil(pending.length / BATCH)} Q#${batchNums[0]}–${batchNums[batchNums.length - 1]}... `);

    const batchResults = await Promise.all(batch.map(async ({ q_num, question }) => {
      const r = await askSync(question);
      r.q_num = q_num;
      r.question = question;
      return r;
    }));

    const batchMs = Date.now() - t0;
    const ok = batchResults.filter(r => !r.error).length;
    const forced = batchResults.filter(r => r.soft_deadline_forced === true).length;
    const models = [...new Set(batchResults.filter(r => r.model).map(r => r.model))];

    batchResults.forEach(r => {
      fs.appendFileSync(OUT_FILE, JSON.stringify(r) + '\n');
      allResults.push(r);
    });

    console.log(`${ok}/${batch.length} OK ${batchMs}ms forced=${forced} model=${models.join(',') || '?'}`);

    // Small inter-batch pause
    await new Promise(r => setTimeout(r, 500));
  }

  const totalMs = Date.now() - start;
  const results = allResults;
  const ok = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);
  const durations = ok.map(r => r.duration);
  const softForced = results.filter(r => r.soft_deadline_forced === true).length;
  const models = [...new Set(ok.map(r => r.model))];

  const summary = {
    total: 100,
    ok: ok.length,
    failed: failed.length,
    total_ms: totalMs,
    avg_duration_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    median_duration_ms: durations.length ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)] : 0,
    max_duration_ms: durations.length ? Math.max(...durations) : 0,
    min_duration_ms: durations.length ? Math.min(...durations) : 0,
    soft_deadline_forced: softForced,
    models_used: models,
    duration_histogram: {
      '<5s': ok.filter(r => r.duration < 5000).length,
      '5-15s': ok.filter(r => r.duration >= 5000 && r.duration < 15000).length,
      '15-30s': ok.filter(r => r.duration >= 15000 && r.duration < 30000).length,
      '30-60s': ok.filter(r => r.duration >= 30000 && r.duration < 60000).length,
      '>60s': ok.filter(r => r.duration >= 60000).length,
    },
    failed_questions: failed.map(r => ({ q_num: r.q_num, question: r.question.slice(0, 80), error: r.error, duration_ms: r.duration })),
    ok_questions: ok.map(r => ({ q_num: r.q_num, question: r.question.slice(0, 80), duration_ms: r.duration, final_len: r.final_len, iterations: r.iterations, soft_deadline_forced: r.soft_deadline_forced, model: r.model })),
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(`OK: ${ok.length}/100, Failed: ${failed.length}/100`);
  console.log(`Avg: ${summary.avg_duration_ms}ms, Median: ${summary.median_duration_ms}ms`);
  console.log(`Max: ${summary.max_duration_ms}ms, Min: ${summary.min_duration_ms}ms`);
  console.log(`soft_deadline_forced=true: ${softForced}`);
  console.log(`Models: ${models.join(', ')}`);
  console.log(`Duration histogram: ${JSON.stringify(summary.duration_histogram)}`);
  console.log(`Total eval time: ${Math.round(totalMs / 60000)}min`);
  if (failed.length) {
    console.log('\nFailed questions:');
    failed.forEach(f => console.log(`  #${f.q_num} (${f.duration_ms}ms): ${f.error}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
