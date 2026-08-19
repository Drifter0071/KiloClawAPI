// Probe the M17191 question through the public zrok tunnel (user's exact path).
// Times the request; prints status, wall time, and body head.
const TOKEN = "b2449de72ebd170f3096b448d1190bfd585113965b558830e6c92179128bfe89";
const URL = "https://nctmechanic.shares.zrok.io/dashboard/api/answer-agent";
const Q = "Kérem az M17191 gép előéletét napjainktól 2024.05.10-ig visszamenőleg";

const started = Date.now();
(async () => {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ q: Q, language: "hu" }),
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const body = await res.text().catch(() => "(no body)");
  console.log(JSON.stringify({
    status: res.status,
    elapsed_s: Number(elapsed),
    body_head: body.slice(0, 600),
  }, null, 2));
})().catch((e) => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(JSON.stringify({ error: String(e?.message ?? e), elapsed_s: Number(elapsed) }, null, 2));
  process.exit(1);
});
