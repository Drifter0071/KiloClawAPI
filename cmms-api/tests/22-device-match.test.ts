// device_match tests — Phase 5.5.
//
// The cache search() does substring match on `d.model` and `d.raw`.
// For machine serials, the LLM extracts them with extractDevice()
// which returns the bare form (M26057), but the database often
// stores them with a hyphen (M-26057). The M26057 case showed
// that strict substring match misses these. This test verifies
// the hyphen-insensitive comparison in all 3 search paths.

import { describe, test, expect } from "bun:test";
import { JobCache, type JobCard } from "../src/cache/jobs";
import type { OpenDbs } from "../src/db/open";

function makeCard(overrides: Partial<JobCard>): JobCard {
  return {
    key: 1,
    sorszam: "B26072216",
    reported_at: "2024-05-10",
    reported_at_iso: "2024-05-10",
    status: "closed",
    technician: null,
    customer: { name: "X Kft.", zip: null, address: null, phone: null, email: null },
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

function setCard(cache: JobCache, key: number, raw: string) {
  const card = makeCard({
    key,
    sorszam: `B260722${String(key).padStart(2, "0")}`,
    devices: [{
      raw,
      model: null, software: null, hardware: null,
      servos: null, controller: null, machine_type: null, freeform: null,
    }],
    _haystack: raw.toLowerCase(),
  });
  // @ts-expect-error - private
  cache.byKey.set(key, card);
}

describe("cache.search: device match is hyphen-insensitive", () => {
  test("stored as 'M-26057' matches device filter 'M26057'", () => {
    const cache = freshCache();
    setCard(cache, 1, "M-26057");
    const out = cache.search({ device: "M26057", limit: 10 });
    expect(out.total).toBe(1);
  });
  test("stored as 'M 26057' (with space) matches 'M26057'", () => {
    const cache = freshCache();
    setCard(cache, 1, "M 26057");
    const out = cache.search({ device: "M26057", limit: 10 });
    expect(out.total).toBe(1);
  });
  test("stored as plain 'M26057' still matches 'M26057'", () => {
    const cache = freshCache();
    setCard(cache, 1, "M26057");
    const out = cache.search({ device: "M26057", limit: 10 });
    expect(out.total).toBe(1);
  });
  test("non-matching device returns 0", () => {
    const cache = freshCache();
    setCard(cache, 1, "M99999");
    const out = cache.search({ device: "M26057", limit: 10 });
    expect(out.total).toBe(0);
  });
  test("model field also matches hyphen-insensitively", () => {
    const cache = freshCache();
    const card = makeCard({
      key: 1,
      devices: [{
        raw: "some other raw",
        model: "DPB-1", software: null, hardware: null,
        servos: null, controller: null, machine_type: null, freeform: null,
      }],
      _haystack: "some other raw",
    });
    // @ts-expect-error - private
    cache.byKey.set(1, card);
    // filter on the model name with hyphen
    const out = cache.search({ device: "DPB1", limit: 10 });
    expect(out.total).toBe(1);
  });
});
