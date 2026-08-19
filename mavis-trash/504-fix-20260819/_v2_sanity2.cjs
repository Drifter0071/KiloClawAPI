// Quick v2 sanity through the exact user path (public zrok -> dashboard proxy -> agent).
const TOKEN = "b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89";
const PUB = "https://nctmechanic.shares.zrok.io";

const QS = [
  "M26057 vezérlés",
  "Hány nyitott ticketje van az ANDRITZ Kft.-nek?",
  "Melyik ügyfélnek volt a legtöbb hibája idén?",
  "B26072216 sorszám",
];

async function ask(q) {
  const t0 = Date.now();
  let status = 0, len = 0, err = "";
  try {
    const r = await fetch(`${PUB}/dashboard/api/answer-agent`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ q, language: "hu" }),
      signal: AbortSignal.timeout(150_000),
    });
    status = r.status;
    const txt = await r.text();
    len = txt.length;
    if (status !== 200) err = txt.slice(0, 120).replace(/\n/g, " ");
    else {
      try {
        const j = JSON.parse(txt);
        err = `final=${(j.final_text ?? "").length}ch iters=${j.iterations} forced=${j.soft_deadline_forced}`;
      } catch { err = "non-json"; }
    }
  } catch (e) {
    err = `fetch error: ${e?.name} ${e?.message}`;
  }
  const ms = Date.now() - t0;
  console.log(`${(ms / 1000).toFixed(1)}s  status=${status}  ${err}`);
}

(async () => {
  console.log(`# v2 sanity via ${PUB} — ${new Date().toISOString()}`);
  for (const q of QS) {
    console.log(`- ${q}`);
    await ask(q);
  }
})();
