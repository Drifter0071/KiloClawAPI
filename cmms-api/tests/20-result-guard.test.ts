// result_guard tests — Phase 5.2.
//
// The guard's job is to prevent the LLM from confabulating answers
// when the search results don't contain the identifier the user asked
// about. Three cases:
//   1. Mismatch detected -> block, return canned response
//   2. Match found        -> pass through unchanged
//   3. No identifiers asked -> pass through (nothing to check)

import { describe, test, expect } from "bun:test";
import { checkResult, extractIds, type AskedIds } from "../src/lib/result_guard";

// ---------------------------------------------------------------------
// extractIds
// ---------------------------------------------------------------------

describe("result_guard: extractIds", () => {
  test("empty args -> no ids", () => {
    expect(extractIds({})).toEqual({});
  });
  test("explicit sorszam field", () => {
    expect(extractIds({ sorszam: "B24090503" })).toEqual({ sorszam: "B24090503" });
  });
  test("explicit device field", () => {
    expect(extractIds({ device: "M09192" })).toEqual({ device: "M09192" });
  });
  test("explicit customer field", () => {
    expect(extractIds({ customer: "ANDRITZ Kft." })).toEqual({ customer: "ANDRITZ Kft." });
  });
  test("B-sorszam in q -> captured as sorszam", () => {
    expect(extractIds({ q: "mi történt a B24090503 jeggyel?" })).toEqual({
      sorszam: "B24090503",
    });
  });
  test("M-sorszam in q -> captured as m_sorszam (machine serial flavor)", () => {
    const ids = extractIds({ q: "M09192 munkánál X tengely csapágyak" });
    expect(ids.m_sorszam).toBe("M09192");
  });
  test("j_szam -> captured as j_szam", () => {
    expect(extractIds({ j_szam: "J00001" })).toEqual({ j_szam: "J00001" });
  });
  test("munkaszam -> captured as munkaszam", () => {
    expect(extractIds({ munkaszam: "M09192" })).toEqual({ munkaszam: "M09192" });
  });
  test("explicit sorszam wins over q-extracted", () => {
    const ids = extractIds({ sorszam: "B24090503", q: "B11111111 másik sorszám" });
    expect(ids.sorszam).toBe("B24090503");
  });
});

// ---------------------------------------------------------------------
// checkResult — match / no-match / block
// ---------------------------------------------------------------------

const MAIN_HIT = {
  sorszam: "B24090503",
  customer: { name: "TRIMBLE HUNGARY KFT." },
  devices: [{ model: "TMV-400", raw: "TMV-400" }],
};

const WRONG_HIT = {
  sorszam: "B11111111",
  customer: { name: "OTHER KFT." },
  devices: [{ model: "DPB-1", raw: "DPB-1" }],
};

const M_SZERVIZ_HIT = {
  j_szam: "J00001",
  cegnev: "ANDRITZ KFT.",
  eszkoz: "TMV-400",
};

describe("result_guard: checkResult — main DB", () => {
  test("passes through when sorszam in hit", () => {
    const r = checkResult({
      ids: { sorszam: "B24090503" },
      response: { total: 1, jobs: [MAIN_HIT] },
      tool: "search_existing_tickets",
      language: "hu",
    });
    expect(r.blocked).toBe(false);
    expect(r.warnings).toHaveLength(0);
  });

  test("blocks when asked sorszam not in any hit", () => {
    const r = checkResult({
      ids: { sorszam: "B24090503" },
      response: { total: 1, jobs: [WRONG_HIT] },
      tool: "search_existing_tickets",
      language: "hu",
    });
    expect(r.blocked).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.canned?.text).toContain("B24090503");
    expect(r.canned?.text).toContain("B11111111");
    expect(r.original).toEqual({ total: 1, jobs: [WRONG_HIT] });
  });

  test("blocks when device asked but not in any hit", () => {
    const r = checkResult({
      ids: { device: "M09192" },
      response: { total: 1, jobs: [WRONG_HIT] },
      tool: "search_existing_tickets",
      language: "hu",
    });
    expect(r.blocked).toBe(true);
  });

  test("blocks when customer asked but not in any hit", () => {
    const r = checkResult({
      ids: { customer: "ANDRITZ Kft." },
      response: { total: 1, jobs: [WRONG_HIT] },
      tool: "search_existing_tickets",
      language: "hu",
    });
    expect(r.blocked).toBe(true);
  });

  test("passes through when all ids match", () => {
    const r = checkResult({
      ids: { sorszam: "B24090503", device: "TMV-400", customer: "TRIMBLE" },
      response: { total: 1, jobs: [MAIN_HIT] },
      tool: "search_existing_tickets",
      language: "hu",
    });
    expect(r.blocked).toBe(false);
  });

  test("blocks when only SOME ids match (sorszam ok, customer wrong)", () => {
    const r = checkResult({
      ids: { sorszam: "B24090503", customer: "ANDRITZ" },
      response: { total: 1, jobs: [MAIN_HIT] },
      tool: "search_existing_tickets",
      language: "hu",
    });
    expect(r.blocked).toBe(true);
  });

  test("passes through with empty results (no hits to mismatch against)", () => {
    const r = checkResult({
      ids: { sorszam: "B24090503" },
      response: { total: 0, jobs: [] },
      tool: "search_existing_tickets",
      language: "hu",
    });
    expect(r.blocked).toBe(false);
  });

  test("passes through when no ids were extracted", () => {
    const r = checkResult({
      ids: {},
      response: { total: 1, jobs: [WRONG_HIT] },
      tool: "search_existing_tickets",
      language: "hu",
    });
    expect(r.blocked).toBe(false);
  });

  test("does NOT block aggregation tools (stats) even with ids", () => {
    const r = checkResult({
      ids: { sorszam: "B24090503" },
      response: { results: [{ name: "ANDRITZ", count: 5 }] },
      tool: "get_ticket_stats",
      language: "hu",
    });
    expect(r.blocked).toBe(false);
  });

  test("bidirectional customer match (asked 'ANDRITZ' matches 'ANDRITZ KFT.')", () => {
    const r = checkResult({
      ids: { customer: "ANDRITZ" },
      response: { total: 1, jobs: [{ sorszam: "B999", customer: { name: "ANDRITZ KFT." } }] },
      tool: "search_existing_tickets",
      language: "hu",
    });
    expect(r.blocked).toBe(false);
  });

  test("English canned response when language=en", () => {
    const r = checkResult({
      ids: { sorszam: "B24090503" },
      response: { total: 1, jobs: [WRONG_HIT] },
      tool: "search_existing_tickets",
      language: "en",
    });
    expect(r.blocked).toBe(true);
    expect(r.canned?.language).toBe("en");
    expect(r.canned?.text).toMatch(/No record/i);
  });

  test("the M09192 -> M11357/M06079 scenario blocks", () => {
    // Simulates: LLM asked q="X tengely golyos orso M09192 munkánál"
    // but called search_serviz_belso which returned a fuzzy hit
    // for M11357/M06079.
    const ids = extractIds({ q: "X tengely golyós orsó csapágyak M09192 munkánál" });
    const response = {
      total: 1,
      jobs: [{
        j_szam: "J00321",
        munkaszam: "M11357/M06079",
        cegnev: "Magyarmet Kft.",
        eszkoz: "Gildemeister GD-5DT",
      }],
    };
    const r = checkResult({ ids, response, tool: "search_serviz_belso", language: "hu" });
    expect(r.blocked).toBe(true);
    expect(r.canned?.text).toContain("M09192");
    expect(r.canned?.text).toContain("M11357");
  });
});

describe("result_guard: checkResult — integration tools", () => {
  test("j_szam mismatch in serviz_belso -> block", () => {
    const r = checkResult({
      ids: extractIds({ j_szam: "J00001" }),
      response: { total: 1, jobs: [{ j_szam: "J99999" }] },
      tool: "search_serviz_belso",
      language: "hu",
    });
    expect(r.blocked).toBe(true);
  });
  test("munkaszam match in szev_igeny -> pass", () => {
    const r = checkResult({
      ids: extractIds({ munkaszam: "M09192" }),
      response: { total: 1, jobs: [{ munkaszam: "M09192", megrendelo: "X Kft." }] },
      tool: "search_szev_igeny",
      language: "hu",
    });
    expect(r.blocked).toBe(false);
  });
});

describe("result_guard: relay-verbatim directive", () => {
  // The mcp-server.ts inlined version wraps the canned text with a
  // "[SZERVER-ŐRJELZÉS: ... SZÓ SZERINT idézd ...]" / "[SERVER GUARD:
  // ... VERBATIM ...]" directive so the LLM is more likely to relay
  // the canned text instead of paraphrasing it into a generic
  // "no results" answer (which is what happened on M09192 in the
  // first round of testing).
  test("mcp-server.ts contains the hu directive", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(import.meta.dir, "..", "mcp-server.ts"), "utf-8");
    expect(src).toContain("SZERVER-ŐRJELZÉS");
    expect(src).toContain("SZÓ SZERINT idézd");
    expect(src).toContain("_relay_verbatim");
  });
  test("mcp-server.ts contains the en directive", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(import.meta.dir, "..", "mcp-server.ts"), "utf-8");
    expect(src).toContain("SERVER GUARD");
    expect(src).toContain("VERBATIM");
  });
});
