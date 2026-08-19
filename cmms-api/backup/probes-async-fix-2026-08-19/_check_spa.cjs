// Sanity: served v2 SPA has the fresh build (async AskPage).
const TUNNEL = "https://nctmechanic.shares.zrok.io";
(async () => {
  const r = await fetch(TUNNEL + "/dashboard/v2/", { redirect: "manual" });
  console.log("v2 http=" + r.status);
  const html = await r.text();
  const m = html.match(/assets\/[a-zA-Z0-9_-]+\.(js|css)/g) || [];
  console.log("assets:", m.slice(0, 8).join(" "));
  const base = "assets/AskPage-" ;
  const t = await fetch(TUNNEL + "/dashboard/v2/" + m[0], { redirect: "manual" });
  console.log("first asset http=" + t.status + " size=" + ((await t.text()).length));
})().catch((e) => { console.error(e.message); process.exit(1); });
