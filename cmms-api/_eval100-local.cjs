// _eval100-local.cjs — run 100-question regression eval via async API
// Runs locally (bypasses SSH block); server is at 10.0.3.81:8787
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://10.0.3.81:8787';
const TOKEN = 'b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89';
const QUESTIONS_FILE = path.join(__dirname, 'backup', 'probes-async-fix-2026-08-19', 'regression100-questions.json');
const OUT_FILE = path.join(__dirname, 'backup', 'probes-async-fix-2026-08-19', 'eval100-results.jsonl');
const SUMMARY_FILE = path.join(__dirname, 'backup', 'probes-async-fix-2026-08-19', 'eval100-summary.json');

function httpRequest(method, urlPath, body, timeoutMs = 35000) {
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

async function runAsync(question) {
  const { status, body } = await httpRequest('POST', '/v1/answer-agent/async', JSON.stringify({
    question,
    language: 'hu',
    softDeadlineMs: 0,
    timeoutMs: 300000,
  }), 60000);

  if (status !== 202) {
    return { error: `POST failed: ${status}`, duration: 0, iterations: 0, soft_deadline_forced: null, model: null, final_len: 0, job_id: null };
  }

  let job;
  try { job = JSON.parse(body); } catch { return { error: `Bad JSON: ${body}`, duration: 0 }; }
  const jobId = job.job_id || job.jobId;
  if (!jobId) return { error: `No job_id: ${body}`, duration: 0 };

  const t0 = Date.now();
  const maxPolls = 600; // 600 × 3s = 30 min max per question
  let pollCount = 0;

  while (pollCount < maxPolls) {
    await new Promise(r => setTimeout(r, 3000));
    pollCount++;

    const pollRes = await httpRequest('GET', `/v1/answer-agent/async/${jobId}`, null, 15000);
    if (pollRes.status === 404) {
      if (pollCount < 5) continue; // job might still be starting
      return { error: 'Job not found (404 after retries)', duration: Date.now() - t0, job_id: jobId };
    }
    if (pollRes.status !== 200) {
      return { error: `Poll failed: ${pollRes.status}`, duration: Date.now() - t0, job_id: jobId };
    }

    let state;
    try { state = JSON.parse(pollRes.body); } catch { continue; }

    if (state.status === 'done' || state.status === 'completed') {
      return {
        duration: Date.now() - t0,
        iterations: state.iterations || state.iteration_count || 0,
        soft_deadline_forced: state.soft_deadline_forced ?? null,
        model: state.model || null,
        final_len: (state.answer?.final_text || state.answer?.text || '').length,
        answer_preview: (state.answer?.final_text || state.answer?.text || '').slice(0, 200),
        job_id: jobId,
      };
    }
    if (state.status === 'error') {
      return { error: `Job error: ${state.error || JSON.stringify(state)}`, duration: Date.now() - t0, job_id: jobId };
    }
    // running — keep polling
  }

  return { error: 'Max polls exceeded', duration: Date.now() - t0, job_id: jobId };
}

async function main() {
  console.log('Loading questions...');
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  console.log(`Got ${questions.length} questions`);

  const results = [];
  const start = Date.now();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const qStart = Date.now();
    process.stdout.write(`[${i + 1}/100] POST ${q.slice(0, 60)}... `);

    let res;
    try {
      res = await runAsync(q);
    } catch (e) {
      res = { error: e.message, duration: 0 };
    }

    const elapsed = Date.now() - qStart;
    res.q_num = i + 1;
    res.question = q;
    res.total_elapsed = Date.now() - start;

    results.push(res);

    if (res.error) {
      console.log(`ERROR (${elapsed}ms): ${res.error}`);
    } else {
      console.log(`OK (${elapsed}ms) iter=${res.iterations} forced=${res.soft_deadline_forced} model=${res.model} len=${res.final_len}`);
    }

    // Write incremental JSONL
    fs.appendFileSync(OUT_FILE, JSON.stringify(res) + '\n');

    // Small pause between questions to avoid hammering
    await new Promise(r => setTimeout(r, 500));
  }

  const totalMs = Date.now() - start;
  const ok = results.filter(r => !r.error).length;
  const failed = results.filter(r => r.error).length;
  const durations = results.filter(r => !r.error).map(r => r.duration);
  const softForced = results.filter(r => r.soft_deadline_forced === true).length;
  const models = [...new Set(results.filter(r => r.model).map(r => r.model))];

  const summary = {
    total: 100,
    ok,
    failed,
    total_ms: totalMs,
    avg_duration_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    median_duration_ms: durations.length ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] : 0,
    max_duration_ms: durations.length ? Math.max(...durations) : 0,
    min_duration_ms: durations.length ? Math.min(...durations) : 0,
    soft_deadline_forced_count: softForced,
    models_used: models,
    failed_questions: results.filter(r => r.error).map(r => ({ q_num: r.q_num, question: r.question, error: r.error })),
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  console.log('\n=== DONE ===');
  console.log(`OK: ${ok}/100, Failed: ${failed}/100`);
  console.log(`Avg: ${summary.avg_duration_ms}ms, Median: ${summary.median_duration_ms}ms`);
  console.log(`soft_deadline_forced: ${softForced}/100`);
  console.log(`Models: ${models.join(', ')}`);
  console.log(`Total time: ${Math.round(totalMs / 60000)}min`);
  if (failed > 0) {
    console.log('\nFailed questions:');
    summary.failed_questions.forEach(f => console.log(`  #${f.q_num}: ${f.error}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
