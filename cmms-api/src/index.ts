// Bootstrap:
//   1. Open both SQLite files.
//   2. Run full ETL if mtime advanced or first run.
//   3. Build in-memory JobCache.
//   4. Run the integration ETL (load CSVs into specialized.db) if a
//      CMMS_INTEGRATION_CSV_DIR is configured and the CSVs are newer
//      than the last build.
//   5. Start file watcher on cmms.db -> triggers incremental ETL +
//      cache rebuild on change.
//   6. Wire up Express routes behind bearer auth.
import { watch, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbs, type OpenDbs } from "./db/open";
import { maybeRunEtl, runIncrementalEtl } from "./db/etl";
import { runIntegration, SOURCES } from "./db/integration";
import { JobCache } from "./cache/jobs";
import { createApp } from "./server";
import { runPhase1BackfillIfNeeded } from "./db/backfill";

function log(msg: string, extra: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

// Phase 7: last-resort safety net. Without these, any uncaught throw
// (e.g. a synchronous throw from a buildSummary call site, or a
// promise rejection from a tool call) kills the process. The express
// error middleware in server.ts only catches errors thrown from inside
// a request handler; errors that bubble up from `.map` callbacks, top
// -level awaits, or setTimeout callbacks skip the middleware and
// reach Bun as uncaught. systemd's Restart=on-failure does the
// recovery, but each crash costs 3+ minutes of cache rebuild — the
// watchdog treats those as a fault too. So: log + survive, let the
// caller see the 500 in the express path, and keep the process alive.
process.on("uncaughtException", (err) => {
  log("uncaught_exception", {
    error: String((err as Error)?.message ?? err),
    stack: String((err as Error)?.stack ?? "").split("\n").slice(0, 5).join(" | "),
  });
  // Note: we deliberately do NOT process.exit(1) here. The express
  // error middleware will have already produced a 500 for any error
  // it caught. For uncaught errors, the request is already over and
  // the safe thing is to keep serving. If a critical state is
  // corrupted, the next request will fail loudly and the watchdog
  // (cmms-api-watchdog.timer) will catch persistent unhealth.
});
process.on("unhandledRejection", (reason) => {
  log("unhandled_rejection", {
    error: String((reason as Error)?.message ?? reason),
    stack: String((reason as Error)?.stack ?? "").split("\n").slice(0, 5).join(" | "),
  });
  // Same policy: log + survive.
});

// Phase 7 L3: best-effort snapshot save. Wraps the save in a
// try/catch so a failed write never blocks the rest of the
// startup path. Returns nothing — the caller doesn't need the
// result. Logs success / failure with byte + job counts.
async function saveCacheSnapshot(
  cache: JobCache,
  snapshotPath: string,
  cmmsMtimeMs: number,
  trigger: string,
): Promise<void> {
  if (process.env.CMMS_SKIP_CACHE_SNAPSHOT === "1") return;
  try {
    const r = await cache.saveSnapshot(snapshotPath, cmmsMtimeMs);
    log("cache_snapshot_saved", {
      trigger,
      path: snapshotPath,
      jobs: r.jobs,
      bytes: r.bytes,
      ms: r.ms,
    });
  } catch (e) {
    log("cache_snapshot_save_failed", {
      trigger,
      error: String((e as Error)?.message ?? e),
    });
  }
}

// Compare the most-recent CSV mtime against the integration build time
// in _meta. Returns true if a rebuild is needed.
function integrationNeedsRebuild(dbs: OpenDbs, csvDir: string): boolean {
  const builtAtRow = dbs.spec
    .query("SELECT value FROM _meta WHERE key = 'integration_built_at'")
    .get() as { value: string } | undefined;
  const builtAt = builtAtRow ? Date.parse(builtAtRow.value) : 0;

  let latestCsvMtime = 0;
  for (const src of SOURCES) {
    const p = join(csvDir, src.file);
    if (!existsSync(p)) continue;
    const m = statSync(p).mtimeMs;
    if (m > latestCsvMtime) latestCsvMtime = m;
  }
  return latestCsvMtime === 0 || latestCsvMtime > builtAt;
}

function maybeRunIntegration(dbs: OpenDbs, csvDir: string): void {
  if (!existsSync(csvDir)) {
    log("integration_csv_dir_missing", { path: csvDir });
    return;
  }
  // Check if any of the integration tables exist at all.
  const has = dbs.spec
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='serviz_belso'")
    .get();
  if (!has || integrationNeedsRebuild(dbs, csvDir)) {
    log("integration_start", { path: csvDir, force: !has });
    try {
      const r = runIntegration({ cmmsDbPath: dbs.cmmsPath, specDbPath: dbs.specializedPath, csvDir });
      log("integration_done", { files: r.files, rows: r.totalRows, ms: r.durationMs, errors: r.errors });
    } catch (e) {
      log("integration_failed", { error: String((e as Error)?.message ?? e) });
    }
  } else {
    log("integration_skipped", { reason: "csvs not newer than last build" });
  }
}

async function start() {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";

  const dbs: OpenDbs = openDbs();
  const cache = new JobCache();
  // Phase 7 L3: load the JobCache from a gzip-JSON snapshot when
  // (a) the snapshot file exists, (b) its embedded cmms.db mtime
  // matches the live one, and (c) snapshot loading isn't disabled
  // via CMMS_SKIP_CACHE_SNAPSHOT. Cuts cold-start from ~3 min
  // (full ETL) to ~5-10s (gunzip + rebuildDerived). The save
  // side is a try/catch wrapper below after each buildFromDb.
  const snapshotPath = process.env.CMMS_CACHE_SNAPSHOT
    ? resolve(process.env.CMMS_CACHE_SNAPSHOT)
    : resolve("/opt/cmms-api/cache-snapshot.json.gz");
  const snapshotDisabled = process.env.CMMS_SKIP_CACHE_SNAPSHOT === "1";

  let loadedFromSnapshot = false;
  if (!snapshotDisabled) {
    try {
      const cmmsStat = statSync(dbs.cmmsPath);
      const m = (JobCache as any).loadSnapshot as (
        p: string,
        m: number,
      ) => Promise<{ byKey: Map<number, any>; jobCount: number; bytes: number; ms: number } | null>;
      const loaded = await m(snapshotPath, cmmsStat.mtimeMs);
      if (loaded) {
        // Reflect the loaded byKey into the cache instance.
        (cache as any).byKey = loaded.byKey;
        (cache as any).dbs = dbs;
        (cache as any).rebuildDerived();
        log("cache_loaded_from_snapshot", {
          path: snapshotPath,
          jobs: loaded.jobCount,
          bytes: loaded.bytes,
          ms: loaded.ms,
          cmmsMtimeMs: cmmsStat.mtimeMs,
        });
        loadedFromSnapshot = true;
      } else {
        log("cache_snapshot_skipped", { path: snapshotPath, reason: "missing/stale" });
      }
    } catch (e) {
      log("cache_snapshot_load_failed", { error: String((e as Error)?.message ?? e) });
    }
  }

  if (!loadedFromSnapshot) {
    log("etl_start", { path: dbs.cmmsPath });
    const res = maybeRunEtl(dbs, { forceFull: !process.env.CMMS_SKIP_FULL_ETL });
    log("etl_done", res);

    cache.buildFromDb(dbs);
    log("cache_built", { jobs: cache.size() });
    // Save the freshly built cache so the next restart can load
    // from disk instead of re-running the 3-min ETL.
    await saveCacheSnapshot(
      cache,
      snapshotPath,
      statSync(dbs.cmmsPath).mtimeMs,
      "startup",
    );
  } else {
    // The snapshot may be slightly out of date if the DB advanced
    // in the gap (the mtime check is best-effort — same mtime, same
    // snapshot). Run the incremental ETL just in case to pick up
    // any rows that landed between snapshot save and this restart.
    try {
      const inc = runIncrementalEtl(dbs);
      if (inc.rows > 0) {
        log("post_snapshot_etl_picked_up", inc);
        cache.buildFromDb(dbs);
        log("cache_rebuilt_after_incremental", { jobs: cache.size() });
        // Re-save so the freshly merged state is on disk for the
        // NEXT restart.
        await saveCacheSnapshot(
          cache,
          snapshotPath,
          statSync(dbs.cmmsPath).mtimeMs,
          "post_snapshot_incremental",
        );
      } else {
        log("post_snapshot_etl_clean");
      }
    } catch (e) {
      log("post_snapshot_etl_failed", { error: String((e as Error)?.message ?? e) });
    }
  }

  // Phase 1 backfill: classify all existing jobs into the inferred
  // kategoria / sulyossag / alkategoria columns. Idempotent — gated
  // by a _meta row. Runs only once per DB. We rebuild the cache
  // afterwards so the inferred fields are loaded into memory.
  try {
    const bf = runPhase1BackfillIfNeeded(dbs);
    if (bf.ran) {
      log("phase1_backfill_done", {
        classified: bf.classified,
        ms: bf.ms,
        top_kat: Object.entries(bf.by_kategoria).sort((a, b) => b[1] - a[1]).slice(0, 5),
        top_sul: Object.entries(bf.by_sulyossag).sort((a, b) => b[1] - a[1]),
        top_alk: bf.by_alkategoria_top10,
      });
      cache.buildFromDb(dbs);
      log("cache_rebuilt_after_backfill", { jobs: cache.size() });
      // The backfill added inferred columns to the DB; re-save
      // so the snapshot includes them.
      await saveCacheSnapshot(
        cache,
        snapshotPath,
        statSync(dbs.cmmsPath).mtimeMs,
        "post_backfill",
      );
    } else {
      log("phase1_backfill_skipped");
    }
  } catch (e) {
    log("phase1_backfill_failed", { error: String((e as Error)?.message ?? e) });
  }

  // CSV integration ETL (optional). Set CMMS_INTEGRATION_CSV_DIR to enable.
  const csvDir = process.env.CMMS_INTEGRATION_CSV_DIR
    ? resolve(process.env.CMMS_INTEGRATION_CSV_DIR)
    : resolve(process.cwd(), "..", "newIntegrationCSVs");
  if (process.env.CMMS_INTEGRATION_CSV_DIR !== "0") {
    maybeRunIntegration(dbs, csvDir);
  }

  // File watcher. Coalesce bursts to a single re-run.
  let pending: NodeJS.Timeout | null = null;
  let lastRun = 0;
  try {
    const watcher = watch(dbs.cmmsPath, { persistent: true }, () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        const now = Date.now();
        if (now - lastRun < 500) return;
        lastRun = now;
        try {
          const r = runIncrementalEtl(dbs);
          if (r.rows > 0) {
            cache.buildFromDb(dbs);
            log("watcher_etl", r);
            // Phase 7 L3: re-save the snapshot so the next restart
            // sees the new rows too. Awaited via .catch to avoid
            // unhandled-promise warnings in the watcher callback.
            void saveCacheSnapshot(
              cache,
              snapshotPath,
              statSync(dbs.cmmsPath).mtimeMs,
              "watcher",
            );
          }
        } catch (e) {
          log("watcher_etl_failed", { error: String((e as Error)?.message ?? e) });
        }
      }, 750);
    });
    watcher.on("error", (e) => log("watcher_error", { error: String(e) }));
  } catch (e) {
    log("watcher_setup_failed", { error: String((e as Error)?.message ?? e) });
  }

  const app = createApp(dbs, cache);

  app.listen(port, host, () => {
    log("listening", { host, port });
  });
}

try {
  // Phase 7 L3: start() is async (it awaits the snapshot load /
  // save). The .catch handler catches both sync throws and async
  // rejections so a snapshot failure still falls through to the
  // process.exit(1) path (which systemd will then auto-restart).
  void start().catch((e) => {
    log("startup_failed", { error: String((e as Error)?.message ?? e) });
    process.exit(1);
  });
} catch (e) {
  log("startup_failed", { error: String((e as Error)?.message ?? e) });
  process.exit(1);
}
