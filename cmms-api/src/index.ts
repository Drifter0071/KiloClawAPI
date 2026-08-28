// Bootstrap (post-pure-RAG rebuild):
//   1. Open both SQLite files.
//   2. Run full ETL if mtime advanced or first run.
//   3. Build the RAG index (FTS5 over ticket notes).
//   4. Start file watcher on cmms.db -> triggers incremental ETL +
//      FTS5 rebuild on change.
//   5. Wire up Express routes (health + /v1/chat/completions only).

import { watch } from "node:fs";
import { openDbs, type OpenDbs } from "./db/open";
import { maybeRunEtl, runIncrementalEtl } from "./db/etl";
import { ensureRagIndex, rebuildRagIndex, type RagIndex } from "./lib/rag";
import { createApp } from "./server";

function log(msg: string, extra: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

function start() {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";

  const dbs: OpenDbs = openDbs();

  log("etl_start", { path: dbs.cmmsPath });
  const res = maybeRunEtl(dbs, { forceFull: !process.env.CMMS_SKIP_FULL_ETL });
  log("etl_done", res);

  // Build the FTS5 RAG index once, after the ETL has committed its
  // rows. Rebuilds only when the ETL actually wrote rows or the
  // index is empty — a no-change restart reuses the existing index
  // and is near-instant.
  const rag: RagIndex = ensureRagIndex(dbs, res.rows > 0);
  log("rag_built", { rows: rag.size(), ms: rag.buildMs, rebuilt: res.rows > 0 });

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
            rebuildRagIndex(dbs, rag);
            log("watcher_etl", { ...r, rag_rows: rag.size() });
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

  const app = createApp(dbs, rag);

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
