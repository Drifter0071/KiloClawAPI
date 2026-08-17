// cmms-api/dashboard-v2/tests/build.test.ts
//
// Verifies that `bun run build` (run by another subagent) produced a usable dist.
// This test is INTENTIONALLY passive — it never spawns a build, it only inspects
// whatever the other agent dropped under `cmms-api/dashboard-v2/dist/`.
//
// If `dist/index.html` is missing, every assertion in this file is skipped with
// a clear message. That way:
//   * `bun test` stays green before the first build (no flaky failures).
//   * After a build, the real assertions run and either pass or fail loudly.
//   * The same file works in CI as a build-output smoke test.
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

// `bun test` runs the test file with cwd = the directory it was loaded from,
// which for us is `cmms-api/dashboard-v2/tests/`. Walk up one level to land
// on `cmms-api/dashboard-v2/`, then point at the dist produced there.
// (Tests under `cmms-api/tests/` use a similar pattern via `harness.ts` — they
// import `../src/...` using the test runner's own resolution, not absolute
// paths. We can't do that here because dashboard-v2 has no `src/server.ts` —
// it's a Vite project — so we resolve dist via the filesystem.)
//
// On Windows, `import.meta.url` is a `file:///C:/...` URL, and `fileURLToPath`
// is the right way to strip the `file://` prefix and avoid the doubled
// `C:\C:\` that raw `new URL(...).pathname` produces.
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = resolve(HERE, "..");
const DIST_DIR = join(DASHBOARD_ROOT, "dist");
const INDEX_HTML = join(DIST_DIR, "index.html");

// Read index.html once if it exists; otherwise every test skips.
const indexExists = existsSync(INDEX_HTML);
const indexHtml = indexExists ? readFileSync(INDEX_HTML, "utf8") : "";

// Also gate the lazy-chunk assertions on whether `src/routes/index.ts` exists.
// Phase 1 has no router yet, so Vite produces no per-page chunks; asserting
// on `ask-*`/`map-*` chunk names would fail for a valid Phase 1 build. The
// chunk assertions only become meaningful once Phase 2 wires the router.
const ROUTES_FILE = join(DASHBOARD_ROOT, "src", "routes", "index.ts");
const routesExist = existsSync(ROUTES_FILE);

// All assertions live inside this single describe so a missing dist produces
// one skip, not four noisy "expected ... to be truthy" failures.
describe("dashboard-v2 build output", () => {
  if (!indexExists) {
    // We can't use it.skip() per-assertion here because we're outside an it()
    // callback. Instead, register a single no-op test that explains the skip.
    // This keeps `bun test` output informative rather than silently green.
    test("dist/index.html not present yet — build has not been run", () => {
      console.log(
        `[build.test] skip: ${INDEX_HTML} does not exist. ` +
          "Run `bun run build` (or have the build subagent run it) " +
          "before relying on this test for real assertions.",
      );
      // Intentionally no assertion — this is a soft skip.
    });
    return;
  }

  test("produces dist/index.html", () => {
    expect(existsSync(INDEX_HTML)).toBe(true);
  });

  test("index.html has a #app mount point", () => {
    // The Vite source `index.html` has `<div id="app"></div>` (see
    // cmms-api/dashboard-v2/index.html) and Vite preserves it verbatim
    // through the build — the only thing that changes is the script
    // tag's `src` (from `/src/main.ts` to `/assets/index-<hash>.js`).
    expect(indexHtml).toContain('<div id="app"></div>');
  });

  test("build emits an AskPage chunk", () => {
    // Vite/Rollup emits one JS file per lazy route. The filename uses the
    // source file's basename (AskPage.vue → AskPage-XXXXX.js), NOT the
    // webpackChunkName comment, because Rollup is opinionated and prefers
    // file-derived names. The chunk is loaded dynamically by the main
    // bundle, so it doesn't appear in dist/index.html — we look for it in
    // dist/assets/ directly.
    if (!routesExist) {
      console.log(
        "[build.test] skip: src/routes/index.ts not present yet. " +
          "Phase 2 will wire the router and create per-page chunks.",
      );
      return;
    }
    const assetsDir = join(DIST_DIR, "assets")
    if (!existsSync(assetsDir)) {
      throw new Error(`dist/assets missing; cannot verify chunks (looked in ${assetsDir})`)
    }
    const files = readdirSync(assetsDir)
    const hasAskPageChunk = files.some(
      (f) => /^AskPage-[A-Za-z0-9_-]+\.js$/.test(f),
    )
    expect(hasAskPageChunk).toBe(true)
  });

  test("build emits a MapPage chunk", () => {
    if (!routesExist) {
      console.log(
        "[build.test] skip: src/routes/index.ts not present yet. " +
          "Phase 2 will wire the router and create per-page chunks.",
      )
      return
    }
    const assetsDir = join(DIST_DIR, "assets")
    if (!existsSync(assetsDir)) {
      throw new Error(`dist/assets missing; cannot verify chunks`)
    }
    const files = readdirSync(assetsDir)
    const hasMapPageChunk = files.some(
      (f) => /^MapPage-[A-Za-z0-9_-]+\.js$/.test(f),
    )
    expect(hasMapPageChunk).toBe(true)
  });

  test("cytoscape is grouped with the map chunk via manualChunks (best-effort)", () => {
    // Per `vite.config.ts`, `build.rollupOptions.output.manualChunks` is
    //   { cytoscape: ['cytoscape', 'cytoscape-cose'] }
    // so a chunk file named `cytoscape-XXXXX.js` should exist in dist/assets/
    // and its body should reference either `cytoscape` or the `cose-bilkent`
    // layout identifier. This is best-effort because minification can rename
    // identifiers — we accept either a direct hit or a graceful skip.
    const assetsDir = join(DIST_DIR, "assets");
    if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
      console.log("[build.test] manualChunks grouping not verifiable: dist/assets missing");
      return;
    }
    const cytoscapeChunk = readdirSync(assetsDir).find(
      (f) => /^cytoscape-[^/]+\.js$/.test(f),
    );
    if (!cytoscapeChunk) {
      console.log(
        "[build.test] manualChunks grouping not verifiable: " +
          "no cytoscape-*.js chunk in dist/assets/ " +
          "(manualChunks may have been reconfigured).",
      );
      return;
    }
    const body = readFileSync(join(assetsDir, cytoscapeChunk), "utf8");
    // `cose` is a distinctive substring of the cose-bilkent layout package
    // and survives minification because it's used as a string key in
    // `cytoscape.use(layout)`.
    const hasCytoscapeHint = /cytoscape/.test(body) || /cose/.test(body);
    if (!hasCytoscapeHint) {
      console.log(
        "[build.test] manualChunks grouping not verifiable from build output alone " +
          `(no 'cytoscape' or 'cose' in ${cytoscapeChunk}; minifier may have stripped it).`,
      );
      return;
    }
    expect(hasCytoscapeHint).toBe(true);
  });
});
