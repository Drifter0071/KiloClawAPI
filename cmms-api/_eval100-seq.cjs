// _eval100-seq.cjs — sequential, 65s timeout per question (catches edge failures at 65s not 95s)
// Continues from existing eval100-sync-results.jsonl
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://10.0.3.81:8787';
const TOKEN = 'b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89';
const QUESTIONS_FILE = path.join(__dirname, 'backup', 'probes-async-fix-2026-08-19', 'regression100-questions.json');
const OUT_FILE = path.join(__dirname, 'backup', 'probes-async-fix-2026-08-19', 'eval100-sync-results.jsonl');
const SUMMARY_FILE = path.join(__dirname, 'backup', 'probes-async-fix-2026-08-19', 'eval100-sync-summary.json');
const Q_TIMEOUT_MS = 65000; // catches edge-cutoff (~60s) in ~65s, not 95s

function httpRequest(method, urlPath, body, timeoutMs = Q_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', e => e.message === 'TIMEOUT' ? reject(new Error('TIMEOUT')) : reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(body);
    req.end();
  });
}

async function askSync(question) {
  const t0 = Date.now();
  try {
    const { status, body } = await httpRequest('POST', '/v1/answer-agent', JSON.stringify({ q: question, language: 'hu' }));
    const elapsed = Date.now() - t0;
    if (status !== 200) return { error: `HTTP ${status}`, duration: elapsed };
    const data = JSON.parse(body);
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
  const existingLines = fs.existsSync(OUT_FILE)
    ? fs.readFileSync(OUT_FILE, 'utf8').trim().split('\n').filter(l => l.trim())
    : [];
  const doneNums = new Set(existingLines.map(l => parseInt(JSON.parse(l).q_num)));
  const pending = questions.map((q, i) => ({ q_num: i + 1, question: q })).filter(x => !doneNums.has(x.q_num));

  console.log(`Total=100 done=${doneNums.size} pending=${pending.length}`);
  if (!pending.length) { console.log('All done!'); return; }

  const start = Date.now();
  const allResults = [...existingLines.map(l => JSON.parse(l))];

  for (let i = 0; i < pending.length; i++) {
    const { q_num, question } = pending[i];
    const qStart = Date.now();
    process.stdout.write(`[${doneNums.size + i + 1}/100 Q#${q_num}] ${question.slice(0, 55)}... `);

    const res = await askSync(question);
    res.q_num = q_num;
    res.question = question;
    res.total_elapsed = Date.now() - start;

    allResults.push(res);
    fs.appendFileSync(OUT_FILE, JSON.stringify(res) + '\n');

    const elapsed = Date.now() - qStart;
    if (res.error) {
      console.log(`TIMEOUT/ERR ${elapsed}ms — soft_deadline_forced=${res.soft_deadline_forced}`);
    } else {
      const flag = res.soft_deadline_forced ? ' ⚠️' : '';
      console.log(`OK ${elapsed}ms iter=${res.iterations}${flag} model=${res.model} len=${res.final_len}`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // Write summary
  const ok = allResults.filter(r => !r.error);
  const failed = allResults.filter(r => r.error);
  const durations = ok.map(r => r.duration);
  const models = [...new Set(ok.map(r => r.model))];

  const summary = {
    total: 100, ok: ok.length, failed: failed.length,
    total_ms: Date.now() - start,
    avg_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    median_ms: durations.length ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)] : 0,
    max_ms: durations.length ? Math.max(...durations) : 0,
    min_ms: durations.length ? Math.min(...durations) : 0,
    soft_deadline_forced: ok.filter(r => r.soft_deadline_forced === true).length,
    soft_deadline_not_forced: ok.filter(r => r.soft_deadline_forced === false).length,
    models_used: models,
    histogram: {
      '<5s': ok.filter(r => r.duration < 5000).length,
      '5-15s': ok.filter(r => r.duration >= 5000 && r.duration < 15000).length,
      '15-30s': ok.filter(r => r.duration >= 15000 && r.duration < 30000).length,
      '30-60s': ok.filter(r => r.duration >= 30000 && r.duration < 60000).length,
      '>60s': ok.filter(r => r.duration >= 60000).length,
    },
    failed_questions: failed.map(r => ({ q_num: r.q_num, question: r.question.slice(0, 80), error: r.error, ms: r.duration })),
    ok_questions: ok.map(r => ({ q_num: r.q_num, question: r.question.slice(0, 80), ms: r.duration, len: r.final_len, iter: r.iterations, forced: r.soft_deadline_forced, model: r.model })),
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  console.log('\n=== DONE ===');
  console.log(`OK: ${ok.length}/100, Failed: ${failed.length}/100`);
  console.log(`Avg: ${summary.avg_ms}ms, Median: ${summary.median_ms}ms, Max: ${summary.max_ms}ms`);
  console.log(`soft_deadline_forced=true: ${summary.soft_deadline_forced}, false: ${summary.soft_deadline_not_forced}`);
  console.log(`Models: ${models.join(', ')}`);
  console.log(`Histogram: ${JSON.stringify(summary.histogram)}`);
  if (failed.length) console.log('Failed: ' + failed.map(f => `#${f.q_num}(${f.ms}ms:${f.error})`).join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });
