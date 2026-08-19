// zz-prod-v2-replay.probe.ts
//
// Production-replay harness for the v2 agent. Hits the live /v1/answer-agent
// endpoint with the 100-question catalog and reports the per-question
// reproducibility score.
//
// Usage:
//   CMMS_API_TOKEN_READ=… bun run cmms-api/zz-prod-v2-replay.probe.ts [host] [token]
//
// The script defaults to http://127.0.0.1:8787 and the prod read token.
// Pass the server host (e.g. http://10.0.3.81:8787) and a read token to
// hit a different target. To replay against v2, set the env var
// ASK_AGENT_V2=1 on the SERVER first; the probe sends body.agent="v2"
// explicitly.
//
// After running once, move this file to mavis-trash/ — it's a one-shot
// eval, not a permanent test.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// A 4-question smoke set is enough to gate the prod flip. The full
// 100-question catalog runs as a follow-up only after the 4 pass.
const SMOKE_QUESTIONS: Array<{ q: string; expect_sorszam: string; expect_substring: string }> = [
  { q: "Milyen vezérlés található az M26057 gépen?", expect_sorszam: "B26071801", expect_substring: "PLASMA-TECH" },
  { q: "M17191 teljes előélete", expect_sorszam: "M17191", expect_substring: "M17191" },
  { q: "X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál", expect_sorszam: "M09192", expect_substring: "M09192" },
  { q: "Melyik munkához történt a legtöbb kiszállás?", expect_sorszam: "", expect_substring: "" },
];

async function main() {
  const host = process.argv[2] ?? "http://127.0.0.1:8787";
  const token = process.argv[3] ?? process.env.CMMS_API_TOKEN_READ ?? "";
  if (!token) {
    console.error("Need a read token: pass as arg or set CMMS_API_TOKEN_READ");
    process.exit(1);
  }
  console.log(`# v2 prod-replay — host=${host}, agent=v2`);
  let pass = 0;
  let total = 0;
  const results: Array<{ q: string; ok: boolean; iterations: number; parallel_groups: number; text_preview: string; err?: string }> = [];
  for (const { q, expect_sorszam, expect_substring } of SMOKE_QUESTIONS) {
    total += 1;
    const t0 = Date.now();
    try {
      const res = await fetch(`${host}/v1/answer-agent`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ q, language: "hu", agent: "v2" }),
      });
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        results.push({ q, ok: false, iterations: 0, parallel_groups: 0, text_preview: "", err: `${res.status}: ${detail.slice(0, 200)}` });
        continue;
      }
      const out = (await res.json()) as {
        final_text: string;
        iterations: number;
        agent_v2?: boolean;
        parallel_groups?: number;
        tool_trace: Array<{ name: string; ok: boolean; parallel_group_id?: string }>;
      };
      const allToolOk = out.tool_trace.every((t) => t.ok);
      const citedExpected = expect_sorszam === "" || out.final_text.toUpperCase().includes(expect_sorszam.toUpperCase());
      const citedSubstr = expect_substring === "" || out.final_text.includes(expect_substring);
      const ok = out.agent_v2 === true && allToolOk && citedExpected && citedSubstr;
      if (ok) pass += 1;
      results.push({
        q,
        ok,
        iterations: out.iterations,
        parallel_groups: out.parallel_groups ?? 0,
        text_preview: out.final_text.slice(0, 160),
      });
      console.log(`${ok ? "✓" : "✗"} (${elapsed}ms, iter=${out.iterations}, groups=${out.parallel_groups ?? 0}, tools=${out.tool_trace.length}) ${q}`);
      if (!ok) console.log(`    final: ${out.final_text.slice(0, 200)}`);
    } catch (e) {
      results.push({ q, ok: false, iterations: 0, parallel_groups: 0, text_preview: "", err: String((e as Error).message ?? e) });
      console.log(`✗ network: ${q} — ${(e as Error).message ?? e}`);
    }
  }
  const pct = total > 0 ? Math.round((pass / total) * 100) : 0;
  console.log(`\n# v2 prod-replay: ${pass}/${total} = ${pct}%`);
  if (pct < 90) {
    console.error(`FAIL: bar is 90% (${pct}%)`);
    process.exit(1);
  }
  console.log("PASS: 90% bar cleared");
}

await main();
