// date_guard tests — Phase 5.3.
//
// The date guard prevents the LLM from injecting date_from/date_to
// for questions that don't actually mention a date. The shared
// module is at src/lib/date_guard.ts (used by both the binary via
// deploy-binary.ts and tests). The mcp-server.ts inlined copy
// exists because deploy-mcp.ts doesn't upload src/; the two must
// stay in sync — see the file-presence test at the bottom.

import { describe, test, expect } from "bun:test";
import { questionHasDate, stripLLMDates } from "../src/lib/date_guard";

// ---- _questionHasDate ----

describe("date_guard: questionHasDate", () => {
  test("no date in the question", () => {
    expect(questionHasDate("M09192 munkánál X tengely golyós orsó csapágyak")).toBe(false);
  });
  test("YYYY.MM.DD style -> true", () => {
    expect(questionHasDate("M17191 előéletét 2024.05.10-ig")).toBe(true);
  });
  test("YYYY-MM-DD style -> true", () => {
    expect(questionHasDate("events from 2024-05-10 onwards")).toBe(true);
  });
  test("YYYY/MM/DD style -> true", () => {
    expect(questionHasDate("2024/05/10 azóta")).toBe(true);
  });
  test("DD.MM.YYYY style -> true", () => {
    expect(questionHasDate("10.05.2024 utáni esetek")).toBe(true);
  });
  test("Hungarian month name -> true", () => {
    expect(questionHasDate("májusi hibák")).toBe(true);
  });
  test("English month name -> true", () => {
    expect(questionHasDate("May 2024 tickets")).toBe(true);
  });
  test("year + -ben/-ban -> true", () => {
    expect(questionHasDate("2024-ben történt esetek")).toBe(true);
  });
  test("null / empty / undefined -> false", () => {
    expect(questionHasDate(null)).toBe(false);
    expect(questionHasDate("")).toBe(false);
    expect(questionHasDate(undefined)).toBe(false);
  });
});

// ---- _stripLLMDates ----

describe("date_guard: stripLLMDates", () => {
  test("no dates in args -> no-op", () => {
    const args = { q: "M09192 munkánál" };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(false);
    expect(r.body).toEqual(args);
  });
  test("LLM passed dates but q has no date and no period -> STRIP", () => {
    const args = {
      q: "M09192 munkánál X tengely golyós orsó csapágyak",
      date_from: "2026-01-01",
      date_to: "2026-08-11",
    };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(true);
    expect(r.body).toBeDefined();
    expect((r.body as any).date_from).toBeUndefined();
    expect((r.body as any).date_to).toBeUndefined();
    expect((r.body as any).q).toBe(args.q);
  });
  test("LLM passed dates and q has a date mention -> KEEP (M17191 case)", () => {
    const args = {
      q: "Kérem az M17191 gép előéletét napjainktól 2024.05.10-ig visszamenőleg",
      date_from: "2024-05-10",
      date_to: "2026-08-11",
    };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(false);
    expect((r.body as any).date_from).toBe("2024-05-10");
  });
  test("LLM passed period token -> KEEP dates (period wins)", () => {
    const args = {
      q: "M09192 munkánál",
      period: "all",
      date_from: "2026-01-01",
    };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(false);
    expect((r.body as any).period).toBe("all");
    expect((r.body as any).date_from).toBe("2026-01-01");
  });
  test("LLM passed period='custom' with dates, no question date -> STRIP (the M09192 case)", () => {
    // This is the exact pattern the LLM was using: period=custom +
    // date_from + date_to + q without any date. The named-token allowlist
    // doesn't include 'custom', so the dates get stripped.
    const args = {
      q: "M09192 munkánál X tengely golyós orsó csapágy",
      period: "custom",
      date_from: "2026-08-01",
      date_to: "2026-08-11",
    };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(true);
    expect((r.body as any).date_from).toBeUndefined();
    expect((r.body as any).date_to).toBeUndefined();
    expect((r.body as any).period).toBeUndefined();
  });
  test("LLM passed period='tavaly' -> KEEP dates (named Hungarian token)", () => {
    const args = {
      q: "kritikus hibák tavaly",
      period: "tavaly",
    };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(false);
  });
  test("LLM passed period='this_month' + dates -> KEEP (named token)", () => {
    const args = {
      q: "M09192 munkánál",
      period: "this_month",
      date_from: "2026-01-01",
    };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(false);
  });
  test("only date_from set, no q, no period -> STRIP", () => {
    const args = { date_from: "2026-01-01" };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(true);
  });
  test("only date_to set, no q, no period -> STRIP", () => {
    const args = { date_to: "2026-08-11" };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(true);
  });
  test("Hungarian date in q -> KEEP", () => {
    const args = {
      q: "tavalyi májusi hibák listája",
      date_from: "2024-05-01",
      date_to: "2024-05-31",
    };
    const r = stripLLMDates(args);
    expect(r.stripped).toBe(false);
  });
  test("undefined args -> no-op", () => {
    const r = stripLLMDates(undefined);
    expect(r.stripped).toBe(false);
    expect(r.body).toBeUndefined();
  });
});

// ---- mcp-server.ts presence check ----

describe("date_guard: mcp-server.ts contains the helpers", () => {
  test("file mentions _stripLLMDates and _questionHasDate", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.join(import.meta.dir, "..", "mcp-server.ts"),
      "utf-8",
    );
    expect(src).toContain("_stripLLMDates");
    expect(src).toContain("_questionHasDate");
    expect(src).toContain("_NAMED_TOKENS");
    expect(src).toContain("period='custom' if present");
  });
});
