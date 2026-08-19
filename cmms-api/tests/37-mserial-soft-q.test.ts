// 37-mserial-soft-q.test.ts — Phase 5c.
//
// Two behaviors added to cache.search():
//   1. Auto-extract an M-serial machine identifier from `q`
//      (e.g. "M09192") and promote it to the device filter when no
//      explicit device was set. This fixes "M09192 munkánál" style
//      questions that previously hit a sorszam-shaped search and
//      returned 0 because no sorszam starts with M.
//   2. When a device filter is in effect, the remaining q tokens
//      become a soft scoring boost instead of a hard AND. The user's
//      q prose ("X tengely golyós orsó csapágyak típusa") is
//      descriptive context, not a literal substring requirement. The
//      answer surfaces even when no single note contains all of
//      "golyós orsó csapágy" verbatim.
//
// Both behaviors together make the answer for the live
// "X tengely golyós orsó csapágyak típusa és mennyisége, M09192
// munkánál" question surface the 50 tickets on the EmL-610 machine
// at METARAD, instead of returning 0.

import { describe, test, expect } from "bun:test";
import { JobCache, type JobCard } from "../src/cache/jobs";
import type { OpenDbs } from "../src/db/open";
import { fold } from "../src/db/parse";

function makeCard(overrides: Partial<JobCard>): JobCard {
  return {
    key: 1,
    sorszam: "B26072216",
    reported_at: "2024-05-10",
    reported_at_iso: "2024-05-10",
    status: "closed",
    technician: null,
    customer: { name: "METARAD KFT.", zip: null, address: null, phone: null, email: null },
    devices: [],
    notes: [],
    problem_kategoria: null,
    problem_alkategoria: null,
    sulyossag: null,
    kategoria_inferred: null,
    kategoria_inferred_conf: null,
    sulyossag_inferred: null,
    sulyossag_inferred_conf: null,
    alkategoria_inferred: null,
    resolution: null,
    _haystack: "",
    ...overrides,
  };
}

const fakeDbs = {} as OpenDbs;

function freshCache(): JobCache {
  return new JobCache(fakeDbs);
}

function setCard(cache: JobCache, key: number, raw: string, noteBody?: string) {
  // Mirror buildHaystack(): fold (diacritic-strip + lowercase) so q-tokens
  // match the same way the production code matches them.
  const haystack = fold([raw, noteBody ?? ""].filter(Boolean).join(" "));
  const card = makeCard({
    key,
    sorszam: `B260722${String(key).padStart(2, "0")}`,
    devices: [{
      raw,
      model: null, software: null, hardware: null,
      servos: null, controller: null, machine_type: null, freeform: null,
    }],
    notes: noteBody ? [{ kind: "work", body: noteBody, author: null, created_at: null }] : [],
    _haystack: haystack,
  });
  // @ts-expect-error - private
  cache.byKey.set(key, card);
}

describe("cache.search: M-serial auto-extraction from q", () => {
  test("'M09192 munkánál' auto-promotes M09192 to a device filter", () => {
    const cache = freshCache();
    setCard(cache, 1, "EmL-610(08277;M09192)");
    setCard(cache, 2, "DPB-1(12345;M99999)"); // different machine, must NOT match
    const out = cache.search({ q: "M09192 munkánál", limit: 10 });
    expect(out.total).toBe(1);
    expect(out.hits[0].job.key).toBe(1);
  });

  test("explicit device wins over M-serial in q", () => {
    const cache = freshCache();
    setCard(cache, 1, "EmL-610(08277;M09192)");
    setCard(cache, 2, "DPB-1(12345;M99999)");
    const out = cache.search({ q: "M99999 valami", device: "M09192", limit: 10 });
    expect(out.total).toBe(1);
    expect(out.hits[0].job.key).toBe(1);
  });

  test("q with no M-serial stays as plain token search", () => {
    const cache = freshCache();
    setCard(cache, 1, "EmL-610", "X tengely recseg");
    setCard(cache, 2, "DPB-1", "Y tengely csapagy");
    const out = cache.search({ q: "csapagy", limit: 10 });
    // 'csapagy' is folded, must match the note body
    expect(out.total).toBe(1);
    expect(out.hits[0].job.key).toBe(2);
  });

  test("short M-serial (<4 digits) is NOT promoted", () => {
    const cache = freshCache();
    setCard(cache, 1, "EmL-610(08277;M123)");
    setCard(cache, 2, "DPB-1(12345;M4567)");
    const out = cache.search({ q: "M123 hello", limit: 10 });
    // M123 has only 3 digits, not auto-promoted; "M123" doesn't appear
    // in any haystack, so 0 hits
    expect(out.total).toBe(0);
  });
});

describe("cache.search: soft-q with device filter", () => {
  test("descriptive q with no note overlap still surfaces the device", () => {
    // Reproduces the live M09192 scenario: the question is
    // "X tengely golyós orsó csapágyak típusa" but no note contains
    // all those words. With the device filter, soft-q scoring means
    // we still return the device's tickets.
    const cache = freshCache();
    setCard(cache, 1, "EmL-610(08277;M09192)", "X motor csere szükséges");
    setCard(cache, 2, "EmL-610(08277;M09192)", "Y tengely csapágyas (4db 30TAC)");
    setCard(cache, 3, "DPB-1(99999;M99999)", "X golyós orsó csere");
    const out = cache.search({ device: "M09192", q: "X tengely golyós orsó csapágyak típusa", limit: 10 });
    // device filter excludes key=3, soft-q scoring includes key=1 and key=2
    expect(out.total).toBe(2);
    const keys = out.hits.map(h => h.job.key).sort();
    expect(keys).toEqual([1, 2]);
  });

  test("soft-q still prefers notes that mention q tokens (scoring boost)", () => {
    const cache = freshCache();
    setCard(cache, 1, "EmL-610(08277;M09192)", "vezérlő csere megtörtént");
    setCard(cache, 2, "EmL-610(08277;M09192)", "X tengely golyós orsó csapágy cseréje");
    const out = cache.search({ device: "M09192", q: "golyós orsó csapágy", limit: 10 });
    expect(out.total).toBe(2);
    // key=2 must rank first because its note contains all 3 q tokens
    expect(out.hits[0].job.key).toBe(2);
  });

  test("without device filter, strict AND still applies (regression)", () => {
    const cache = freshCache();
    setCard(cache, 1, "EmL-610", "X tengely");
    setCard(cache, 2, "DPB-1", "X tengely csapágy");
    const out = cache.search({ q: "X tengely csapágy", limit: 10 });
    // No device filter → strict AND → only key=2 has all 3 tokens
    expect(out.total).toBe(1);
    expect(out.hits[0].job.key).toBe(2);
  });

  test("soft-q ranks exact M-serial hits above non-matching", () => {
    const cache = freshCache();
    setCard(cache, 1, "EmL-610(08277;M09192)", "karbantartás");
    setCard(cache, 2, "EmL-610(08277;M15250)", "X tengely golyós orsó csapágy");
    setCard(cache, 3, "DPB-1(99999;M99999)", "X tengely golyós orsó csapágy");
    const out = cache.search({ q: "M09192 X tengely golyós orsó csapágy", limit: 10 });
    // M09192 → device filter to M09192 → only key=1 matches the device
    expect(out.total).toBe(1);
    expect(out.hits[0].job.key).toBe(1);
  });
});
