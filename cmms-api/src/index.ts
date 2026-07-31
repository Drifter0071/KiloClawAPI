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

function log(msg: string, extra: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
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

function start() {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";

  const dbs: OpenDbs = openDbs();
  const cache = new JobCache();

  log("etl_start", { path: dbs.cmmsPath });
  const res = maybeRunEtl(dbs, { forceFull: !process.env.CMMS_SKIP_FULL_ETL });
  log("etl_done", res);

  cache.buildFromDb(dbs);
  log("cache_built", { jobs: cache.size() });

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
  start();
} catch (e) {
  log("startup_failed", { error: String((e as Error)?.message ?? e) });
  process.exit(1);
}
