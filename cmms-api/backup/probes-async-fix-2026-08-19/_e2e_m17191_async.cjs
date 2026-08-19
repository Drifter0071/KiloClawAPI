// End-to-end M17191 async verification through the zrok tunnel.
//   POST https://nctmechanic.shares.zrok.io/dashboard/api/answer-agent  (async: true)
//   GET  .../answer-agent/:jobId  → poll until done
// Expect: 202 fast, job completes in ~90-150s, full 12-ticket answer,
//         soft_deadline_forced === false, NO 504, NO forced truncation.
// Run: bun _e2e_m17191_async.cjs
const TUNNEL = "https://nctmechanic.shares.zrok.io";
const TOKEN = "b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89";
const Q = "Kérem az M17191 gép előéletét napjainktól 2024.05.10-ig visszamenőleg";

async function main() {
  const t0 = Date.now();
  console.log(`[t=0s] POST async question through tunnel...`);
  const postR = await fetch(`${TUNNEL}/dashboard/api/answer-agent`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ q: Q, language: "hu", async: true }),
  });
  const postBody = await postR.json();
  console.log(`[t=${((Date.now() - t0) / 1000).toFixed(1)}s] POST status=${postR.status}`);
  if (postR.status !== 202 || !postBody.job_id) {
    console.log("UNEXPECTED POST RESULT:", JSON.stringify(postBody).slice(0, 400));
    process.exit(1);
  }
  const jobId = postBody.job_id;
  console.log(`job_id=${jobId}`);

  let lastStatus = "";
  const polls = [];
  while (Date.now() - t0 < 330_000) {
    await new Promise((res) => setTimeout(res, 5000));
    const r = await fetch(`${TUNNEL}/dashboard/api/answer-agent/${jobId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await r.json();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status === 504 || r.status === 502) {
      console.log(`[t=${elapsed}s] POLL HTTP ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
      console.log("FAIL: tunnel edge cut the poll.");
      process.exit(1);
    }
    polls.push({ t: elapsed, status: body.status, http: r.status });
    if (body.status === "done" || body.status === "error") {
      lastStatus = body.status;
      if (body.status === "done") {
        const res = body.result;
        console.log(`[t=${elapsed}s] DONE after ${((Date.now() - t0) / 1000).toFixed(1)}s total`);
        console.log(`iterations=${res.iterations}  model=${res.model}`);
        console.log(`soft_deadline_forced=${res.soft_deadline_forced}`);
        console.log(`answer_id=${res.answer_id}`);
        console.log(`tool_trace=${res.tool_trace.map((s) => s.name).join(", ")}`);
        console.log(`final_text len=${res.final_text.length}`);
        console.log("--- final_text ---");
        console.log(res.final_text.slice(0, 1500));
        console.log("--- end ---");
        if (res.soft_deadline_forced) {
          console.log("FAIL: soft deadline was forced on the async path!");
          process.exit(1);
        }
        if (!/12 jegy|12 ticket|12 db|12 darab/i.test(res.final_text) && res.iterations < 3) {
          console.log("WARN: answer may be incomplete (few iterations, no 12-ticket mention).");
        }
        console.log("PASS: async no-time-limit flow verified through the tunnel.");
        process.exit(0);
      }
      console.log(`[t=${elapsed}s] JOB ERROR: ${JSON.stringify(body.error)}`);
      process.exit(1);
    }
    if (body.status !== lastStatus) {
      lastStatus = body.status;
      console.log(`[t=${elapsed}s] status=${body.status}${body.elapsed_s != null ? ` (job elapsed ${body.elapsed_s}s)` : ""}`);
    }
  }
  console.log("FAIL: job never finished within 330s. Poll history:", JSON.stringify(polls));
  process.exit(1);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
