// Reproduce the user's 504 path: public zrok URL -> dashboard proxy -> agent.
// Uses bearer auth (what the dashboard SPA sends after login).
const TOKEN = "b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89";
const PUB = "https://nctmechanic.shares.zrok.io";

const SLOW_QS = [
  "Mi a TMV-400 és NCT104 kombináció eloszlása?", // 84s yesterday
  "Volt-e 2018-ban telephelyi javítás erre a TMV-400 gépre?", // 66s yesterday
  "Mutass egy konkrét belső szerviz J-sorszámot", // 73s yesterday
];
const FAST_Q = "Hány nyitott ticketje van az ANDRITZ Kft.-nek?";

async function ask(q, url) {
  const t0 = Date.now();
  let status = 0, len = 0, err = "";
  try {
    const r = await fetch(`${url}/dashboard/api/answer-agent`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${TOKEN}` },
      body: JSON.stringify({ q, language: "hu" }),
      signal: AbortSignal.timeout(150_000),
    });
    status = r.status;
    const txt = await r.text();
    len = txt.length;
    if (status !== 200) {
      err = txt.slice(0, 160).replace(/\n/g, " ");
    } else {
      try { const j = JSON.parse(txt); err = `final_len=${(j.final_text ?? "").length}`; } catch { err = "non-json"; }
    }
  } catch (e) {
    err = `fetch error: ${e?.name} ${e?.message}`;
  }
  const ms = Date.now() - t0;
  console.log(`${url} ${ms >= 1000 ? ms / 1000 + "s" : ms + "ms"}  status=${status}  ${err ? "| " + err : ""}`);
  return { ms, status };
}

(async () => {
  console.log(`# 504 repro — ${PUB} (bearer auth)\n`);
  console.log("-- fast question first (baseline) --");
  await ask(FAST_Q, PUB);

  console.log("\n-- slow questions (agent p95 ~44s, tail 60-124s) --");
  for (const q of SLOW_QS) {
    const r = await ask(q, PUB);
    console.log(`   ${r.status === 504 ? "!!! 504 — zrok or proxy cut the request" : r.status === 200 ? "ok" : ""}`);
  }
})();
