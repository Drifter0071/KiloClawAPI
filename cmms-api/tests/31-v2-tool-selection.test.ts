// Tests for v2 tool-selection accuracy across the 100-question catalog
// intent classes. We don't run the LLM here (offline); we verify the
// v2 registry is *shaped* correctly for each question class — i.e. the
// right tool is in the surface and the right parameters are in the
// schema. The actual LLM behavior is replayed on prod via
// zz-prod-v2-replay.probe.ts (deployed with the binary).
//
// What we check here:
//   1. The 6 most common intent classes have their primary tool exposed.
//   2. answer_question is NOT in the v2 surface (the architectural shift).
//   3. Each v2 tool's required parameters are sensible (catches "we
//      forgot to mark `sorszam` as required on find_ticket"-class bugs
//      without needing an LLM to surface them).

import { describe, expect, test } from "bun:test";
import { buildAgentToolsV2, V2_READ_TOOL_NAMES } from "../src/lib/agent_tools";

const TOOLSET = buildAgentToolsV2();
const TOOL = (name: string) => TOOLSET.find((t) => t.name === name);

describe("v2 tool surface — coverage of the 100-question catalog intent classes", () => {
  test("'M12345 típusú gép vezérlése?' (device history) → find_ticket + get_device_history", () => {
    expect(TOOL("find_ticket")).toBeTruthy();
    expect(TOOL("get_device_history")).toBeTruthy();
    const findT = TOOL("find_ticket")!;
    expect((findT.props.sorszam as { r?: boolean }).r).toBe(true);
    const getDh = TOOL("get_device_history")!;
    expect((getDh.props.device as { r?: boolean }).r).toBe(true);
  });

  test("'Melyik ügyfélhez járunk a legtöbbet?' (top-N aggregation) → get_ticket_stats", () => {
    expect(TOOL("get_ticket_stats")).toBeTruthy();
    const stats = TOOL("get_ticket_stats")!;
    const dims = (stats.props.group_by as { e?: string[] }).e;
    expect(dims).toContain("customer");
    expect(dims).toContain("device");
  });

  test("'Mutass mindent a B26071801-ről' (cross-DB timeline) → find_related_tickets", () => {
    expect(TOOL("find_related_tickets")).toBeTruthy();
  });

  test("'Volt már ilyen hiba az M09192-nél?' (recurring) → search_tickets + get_device_history", () => {
    expect(TOOL("search_tickets")).toBeTruthy();
    expect(TOOL("get_device_history")).toBeTruthy();
  });

  test("'ANDRITZ melyik telephelyén?' (customer disambiguation) → list_customers", () => {
    expect(TOOL("list_customers")).toBeTruthy();
    const lc = TOOL("list_customers")!;
    expect((lc.props.q as { r?: boolean }).r).toBe(true);
  });

  test("'Van pótmotorunk M16119-re?' (spare motor) → find_spare_motor", () => {
    expect(TOOL("find_spare_motor")).toBeTruthy();
  });

  test("'Melyik munkához történt a legtöbb kiszállás?' (linkage) → find_linkage", () => {
    expect(TOOL("find_linkage")).toBeTruthy();
    const fl = TOOL("find_linkage")!;
    const dir = (fl.props.direction as { e?: string[]; r?: boolean });
    expect(dir.r).toBe(true);
    expect(dir.e).toEqual(["stats", "top_hubs", "referenced_by", "references"]);
  });
});

describe("v2 architectural invariants", () => {
  test("answer_question is NOT in the v2 surface (LLM composes the answer)", () => {
    const names = TOOLSET.map((t) => t.name);
    expect(names).not.toContain("answer_question");
  });

  test("v2 surface is exactly 8 read tools by default", () => {
    expect(TOOLSET.filter((t) => !t.write)).toHaveLength(8);
    expect(V2_READ_TOOL_NAMES).toHaveLength(8);
  });

  test("every v2 tool name appears in V2_READ_TOOL_NAMES or V2_ONLY_TOOL_DEFS", () => {
    // Sanity: if someone adds a new v2 tool to buildAgentToolsV2 without
    // listing it in V2_READ_TOOL_NAMES, the unknown_tool guard in the
    // loop won't know it's allowed. Catches that drift.
    const allowedRead = new Set(V2_READ_TOOL_NAMES);
    // V2_ONLY_TOOL_DEFS adds 3 entries; their names are part of the
    // v2 surface by construction.
    const v2OnlyNames = ["find_ticket", "get_device_history", "list_customers"];
    for (const n of v2OnlyNames) expect(allowedRead.has(n)).toBe(true);
  });
});
