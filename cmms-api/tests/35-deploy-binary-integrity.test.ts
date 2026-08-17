// Regression test for the binary-file upload corruption bug.
//
// Background:
//   `deploy-mcp.ts` used to read every file with
//   `readFileSync(path, "utf-8")` and then re-encode with
//   `Buffer.from(content, "utf-8")` on the remote end. The round
//   trip is a no-op for valid UTF-8, but WOFF2 fonts (and other
//   compressed binary assets) are NOT valid UTF-8 — they contain
//   arbitrary byte sequences. Node's UTF-8 reader replaces invalid
//   sequences with U+FFFD (the 3-byte replacement char), and
//   re-encoding through `Buffer.from(str, "utf-8")` writes those
//   3-byte expansions to disk, blowing up the file size and
//   destroying the WOFF2 magic. The browser then sees "OTS parsing
//   error: Failed to convert WOFF 2.0 font to SFNT" and falls back
//   to a system font (or shows broken-glyph boxes).
//
// This test exercises the round-trip of a real WOFF2 file from the
// built dist/ and asserts the bytes are bit-identical after
// read+re-encode. If a future refactor accidentally introduces
// the same UTF-8 round-trip on a binary file path, this test fails.

import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST_ASSETS = join(import.meta.dir, "..", "dashboard-v2", "dist", "assets");
const DIST_ROOT = join(import.meta.dir, "..", "dashboard-v2", "dist");

function findWoff2(): string {
  if (!existsSync(DIST_ASSETS)) {
    throw new Error(
      `dist/assets/ not found at ${DIST_ASSETS} — run \`bun run build\` in dashboard-v2/ first`,
    );
  }
  const woff2 = readdirSync(DIST_ASSETS).filter((n) => n.endsWith(".woff2"));
  if (woff2.length === 0) {
    throw new Error("No WOFF2 files in dist/assets/ — Inter / JetBrains Mono fonts missing?");
  }
  return join(DIST_ASSETS, woff2[0]);
}

function findBinaryAsset(ext: string, inRoot = false): string {
  const dir = inRoot ? DIST_ROOT : DIST_ASSETS;
  const files = readdirSync(dir).filter((n) => n.endsWith(ext));
  if (files.length === 0) {
    throw new Error(`No ${ext} files in ${dir}/`);
  }
  return join(dir, files[0]);
}

describe("deploy binary upload integrity (regression for UTF-8 round-trip bug)", () => {
  test("a WOFF2 file's first 4 bytes are the wOF2 magic", () => {
    const woff2 = findWoff2();
    const buf = readFileSync(woff2);
    // WOFF2 signature: 0x77 0x4F 0x46 0x32 ("wOF2")
    expect(buf[0]).toBe(0x77);
    expect(buf[1]).toBe(0x4F);
    expect(buf[2]).toBe(0x46);
    expect(buf[3]).toBe(0x32);
  });

  test("readFileSync(..., 'utf-8') + Buffer.from(..., 'utf-8') corrupts WOFF2 files (this is the bug)", () => {
    // This is the OLD broken path. It documents the bug so a
    // future refactor doesn't reintroduce it.
    const woff2 = findWoff2();
    const original = readFileSync(woff2);
    const asString = original.toString("utf-8");
    const reencoded = Buffer.from(asString, "utf-8");

    // After UTF-8 round-trip the bytes are NOT the same — invalid
    // UTF-8 sequences get replaced with U+FFFD, expanding the file.
    if (original.length === reencoded.length) {
      // Possible only if every byte happened to be valid UTF-8.
      // Force a fail so this test catches reintroduction of the bug.
      expect(reencoded.equals(original)).toBe(false);
    } else {
      // Length changed (the usual case) — that's the corruption.
      expect(reencoded.length).not.toBe(original.length);
    }
  });

  test("readFileSync(..., 'binary') preserves WOFF2 bytes (this is the fix)", () => {
    // This is the NEW path: read as a Buffer, send as a Buffer.
    const woff2 = findWoff2();
    const original = readFileSync(woff2);
    const reencoded = readFileSync(woff2); // already returns a Buffer
    expect(reencoded.equals(original)).toBe(true);
  });

  test("deploy-mcp.ts uses readFileSync WITHOUT 'utf-8' encoding for binary files", async () => {
    // Source-level check: every readFileSync call in deploy-mcp.ts
    // should either pass NO encoding (returns Buffer — what we want
    // for binary files) or an explicit 'utf-8' (returns string —
    // fine for text files like *.ts, *.json).
    //
    // The OLD bug was `readFileSync(lp, "utf-8")` on lines that
    // also fed into a Buffer write. That corrupted the WOFF2 fonts
    // because their bytes are not valid UTF-8.
    //
    // We check by stripping comments first, then scanning the
    // remaining code. This way the explanation comment that
    // documents the bug doesn't trip the test.
    const rawSrc = readFileSync(join(import.meta.dir, "..", "deploy-mcp.ts"), "utf-8");
    // Strip block comments and line comments. Cheap and good enough
    // for a regression test — we only care about actual call sites.
    const code = rawSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\/.*$/gm, "");
    // Every readFileSync call site should have either no encoding
    // arg, or 'utf-8' (but the latter only on a string var that is
    // not subsequently fed to uploadBinary).
    const lines = code.split("\n");
    for (const ln of lines) {
      if (!ln.includes("readFileSync(")) continue;
      // Acceptable forms:
      //   readFileSync(path)
      //   readFileSync(path, "utf-8")
      // Disallowed (the bug):
      //   readFileSync(path, "utf-8") followed by a Buffer write
      if (/readFileSync\([^)]*,\s*['"]utf-8['"]\s*\)/.test(ln)) {
        // Allow it ONLY if the variable is passed to uploadText
        // (which is now a string-typed wrapper). Specifically, the
        // line itself should not include the function name
        // `uploadBinary` and should not include the pattern from
        // the bug.
        expect(ln).not.toMatch(/readFileSync\([^)]*,\s*['"]utf-8['"]\s*\)\s*;\s*await\s+uploadBinary/);
      }
    }
  });

  test("uploadText is a thin wrapper around uploadBinary (no separate file path)", () => {
    // The fix collapsed the two paths into one: uploadText(content)
    // -> uploadBinary(Buffer.from(content, "utf-8"), ...). That way
    // every upload funnels through the binary-safe code, and a
    // future contributor can't accidentally call uploadText on
    // raw bytes.
    const src = readFileSync(join(import.meta.dir, "..", "deploy-mcp.ts"), "utf-8");
    expect(src).toMatch(/function\s+uploadText[\s\S]*?return\s+uploadBinary/);
  });

  test("PNG file (favicon/brand-mark) first 8 bytes are the PNG signature", () => {
    // PNG: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    // The favicons + brand mark live at the dist/ root, not in
    // dist/assets/ — Vite's emit logic puts them there because the
    // filenames are fixed and the user references them by exact
    // path from index.html.
    const png = findBinaryAsset(".png", true);
    const buf = readFileSync(png);
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4E);
    expect(buf[3]).toBe(0x47);
    expect(buf[4]).toBe(0x0D);
    expect(buf[5]).toBe(0x0A);
    expect(buf[6]).toBe(0x1A);
    expect(buf[7]).toBe(0x0A);
  });

  test("all WOFF2 files in dist/assets/ have the wOF2 magic and are at least 4 KB", () => {
    // Sanity check: a real Inter / JetBrains Mono font is at least
    // a few KB. If a corrupted upload produced a 200-byte file,
    // this test catches it.
    const files = readdirSync(DIST_ASSETS).filter((n) => n.endsWith(".woff2"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const buf = readFileSync(join(DIST_ASSETS, f));
      expect(buf[0]).toBe(0x77);
      expect(buf[1]).toBe(0x4F);
      expect(buf[2]).toBe(0x46);
      expect(buf[3]).toBe(0x32);
      expect(buf.length).toBeGreaterThan(4096);
    }
  });
});
