// One-shot backfill: classify every job in cmms_specialized.db and
// write the inferred kategoria / sulyossag / alkategoria. Idempotent.
//
// Why this is a separate file (and not in open.ts)
// ------------------------------------------------
// openDbs() is called on every server start; we don't want a 60s
// classification pass there. Instead, runPhase1BackfillIfNeeded() is
// invoked by src/index.ts on boot. It is gated by a _meta row
// (phase1_backfill_done=1) so the heavy work happens at most once
// per database. Subsequent boots are O(1) — they just read the
// _meta flag.
//
// On a fresh DB (no jobs) the script is a no-op.

import type { OpenDbs } from "./open";
import { classify, type Classification } from "../lib/classifier";

type JobRow = {
  key: number;
  reported: string | null;
  work: string | null;
  devices: {
    model: string | null;
    controller: string | null;
    machine_type: string | null;
    raw_type: string | null;
  }[];
};

export type BackfillResult = {
  ran: boolean;
  classified: number;
  ms: number;
  by_kategoria: Record<string, number>;
  by_sulyossag: Record<string, number>;
  by_alkategoria_top10: { name: string; count: number }[];
};

const META_KEY = "phase1_backfill_done";

export function runPhase1BackfillIfNeeded(dbs: OpenDbs): BackfillResult {
  const start = performance.now();
  const empty: BackfillResult = {
    ran: false,
    classified: 0,
    ms: 0,
    by_kategoria: {},
    by_sulyossag: {},
    by_alkategoria_top10: [],
  };

  // Skip if we already ran (or there's nothing to do).
  const flag = dbs.stmts.getMeta.get(META_KEY) as { value: string | null } | null;
  if (flag && flag.value === "1") {
    return empty;
  }

  // Count rows so we can skip on a fresh DB.
  const cnt = dbs.spec.prepare(`SELECT COUNT(*) AS c FROM jobs`).get() as { c: number };
  if (cnt.c === 0) {
    // Still mark as done so we don't keep checking.
    dbs.stmts.setMeta.run(META_KEY, "1");
    return empty;
  }

  // Safety net: if the inferred columns are already fully populated
  // (e.g. the previous run did the work but the setMeta commit was
  // lost in a SIGKILL), skip the heavy work. The _meta flag is the
  // primary gate; this is a belt-and-suspenders against a forgotten
  // flag. We require 99% coverage to avoid masking partial fills.
  const infCount = dbs.spec
    .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE kategoria_inferred IS NOT NULL`)
    .get() as { c: number };
  if (infCount.c >= Math.floor(cnt.c * 0.99) && infCount.c > 0) {
    dbs.stmts.setMeta.run(META_KEY, "1");
    return empty;
  }

  // Pull all jobs with their notes + devices in a single sweep. We
  // need the reported + work text for the classifier; for devices
  // we just need model/controller/machine_type/raw. The correlated
  // subqueries on notes rely on idx_notes_job_key_kind (added in
  // open.ts) to avoid the full-table-scan hang the previous version
  // hit on production (130k scans of a 100k-row table = 30+ minutes).
  const jobRows = dbs.spec.prepare(
    `SELECT j.key AS key,
            (SELECT n.body FROM notes n WHERE n.job_key = j.key AND n.kind = 'reported' ORDER BY n.id LIMIT 1) AS reported,
            (SELECT n.body FROM notes n WHERE n.job_key = j.key AND n.kind = 'work' ORDER BY n.id LIMIT 1) AS work
     FROM jobs j`,
  ).all() as { key: number; reported: string | null; work: string | null }[];

  const devRows = dbs.spec.prepare(
    `SELECT job_key, model, controller, machine_type, raw_type FROM devices`,
  ).all() as {
    job_key: number;
    model: string | null;
    controller: string | null;
    machine_type: string | null;
    raw_type: string | null;
  }[];

  const devicesByKey = new Map<number, JobRow["devices"]>();
  for (const d of devRows) {
    const arr = devicesByKey.get(d.job_key) ?? [];
    arr.push({
      model: d.model,
      controller: d.controller,
      machine_type: d.machine_type,
      raw_type: d.raw_type,
    });
    devicesByKey.set(d.job_key, arr);
  }

  const byKat: Record<string, number> = {};
  const bySul: Record<string, number> = {};
  const alkCount = new Map<string, number>();

  // Write in a single transaction; one UPDATE per job.
  const update = dbs.stmts.updateJobInferred;
  const tx = dbs.spec.transaction((rows: { key: number; cls: Classification; alk: string | null }[]) => {
    for (const r of rows) {
      update.run(
        r.cls.kategoria_inferred,
        r.cls.kategoria_confidence,
        r.cls.sulyossag_inferred,
        r.cls.sulyossag_confidence,
        r.alk,
        r.key,
      );
    }
  });

  const BATCH = 500;
  let classified = 0;
  let batch: { key: number; cls: Classification; alk: string | null }[] = [];
  for (const row of jobRows) {
    const cls = classify({
      reported: row.reported,
      work: row.work,
      devices: devicesByKey.get(row.key) ?? [],
    });
    const alk = cls.alkategoria_inferred;
    batch.push({ key: row.key, cls, alk });
    byKat[cls.kategoria_inferred] = (byKat[cls.kategoria_inferred] ?? 0) + 1;
    bySul[cls.sulyossag_inferred] = (bySul[cls.sulyossag_inferred] ?? 0) + 1;
    if (alk) alkCount.set(alk, (alkCount.get(alk) ?? 0) + 1);
    if (batch.length >= BATCH) {
      tx(batch);
      classified += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    tx(batch);
    classified += batch.length;
  }

  // Mark done.
  dbs.stmts.setMeta.run(META_KEY, "1");

  const alkTop10 = [...alkCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    ran: true,
    classified,
    ms: Math.round(performance.now() - start),
    by_kategoria: byKat,
    by_sulyossag: bySul,
    by_alkategoria_top10: alkTop10,
  };
}
