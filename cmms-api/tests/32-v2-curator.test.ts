// Tests for curateV2Toolset: the bridge between the deterministic
// router and the v2 agent. We verify the curator picks the right
// primary + fallbacks for each intent class, AND that the v2 subset
// function returns the right tools.

import { describe, expect, test } from "bun:test";
import { routeQuestion, curateV2Toolset } from "../src/lib/router";
import { buildAgentToolsV2Subset, V2_READ_TOOL_NAMES } from "../src/lib/agent_tools";

describe("curateV2Toolset — primary tool per intent class", () => {
  test("device_tickets_list → get_device_history primary", () => {
    const c = curateV2Toolset(routeQuestion("M26057 vezérlése?", "hu"), "M26057 vezérlése?", "hu");
    expect(c.primary).toBe("get_device_history");
    expect(c.tools.length).toBeLessThanOrEqual(4);
    // Should also offer search_tickets as a fallback
    expect(c.tools).toContain("search_tickets");
  });

  test("find_ticket_by_sorszam → find_ticket primary", () => {
    const c = curateV2Toolset(routeQuestion("B26071801?", "hu"), "B26071801?", "hu");
    expect(c.primary).toBe("find_ticket");
    expect(c.tools.length).toBeLessThanOrEqual(4);
  });

  test("top_customers → get_ticket_stats primary", () => {
    const c = curateV2Toolset(routeQuestion("Melyik ügyfélhez járunk a legtöbbet?", "hu"), "Melyik ügyfélhez járunk a legtöbbet?", "hu");
    expect(c.primary).toBe("get_ticket_stats");
    expect(c.tools).toContain("search_tickets"); // drill-down fallback
  });

  test("top_hubs → find_linkage primary", () => {
    const c = curateV2Toolset(routeQuestion("Melyik munkához történt a legtöbb kiszállás?", "hu"), "Melyik munkához történt a legtöbb kiszállás?", "hu");
    expect(c.primary).toBe("find_linkage");
  });

  test("find_related (M09192 története) → find_related_tickets primary, suggestedArgs have device", () => {
    const c = curateV2Toolset(routeQuestion("M09192 története", "hu"), "M09192 története", "hu");
    expect(c.primary).toBe("find_related_tickets");
    expect(c.suggestedArgs.find_related_tickets?.device).toContain("M09192");
  });

  test("part_spec (M09192 munkánál) → get_device_history primary (router says part_spec, but device is present)", () => {
    const c = curateV2Toolset(
      routeQuestion("X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál", "hu"),
      "X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál",
      "hu",
    );
    // Router says part_spec / search_tickets, but device=M09192 → v2 picks get_device_history
    expect(c.primary).toBe("get_device_history");
    expect(c.suggestedArgs.get_device_history?.device).toContain("M09192");
  });

  test("device_tickets_list → get_device_history primary", () => {
    const c = curateV2Toolset(routeQuestion("M26057 vezérlése?", "hu"), "M26057 vezérlése?", "hu");
    expect(c.primary).toBe("get_device_history");
    expect(c.tools.length).toBeLessThanOrEqual(4);
    expect(c.tools).toContain("search_tickets");
  });
});

describe("curateV2Toolset — size is bounded (2-4 tools per question)", () => {
  test("never more than 4 tools", () => {
    const samples = [
      "M26057 vezérlése?",
      "B26071801?",
      "Melyik ügyfélhez járunk a legtöbbet?",
      "Melyik munkához történt a legtöbb kiszállás?",
      "Mutass mindent a B26071801-ről",
      "ANDRITZ melyik telephelyén?",
      "X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál",
      "Hány kritikus hibás van?",
    ];
    for (const q of samples) {
      const c = curateV2Toolset(routeQuestion(q, "hu"), q, "hu");
      expect(c.tools.length).toBeLessThanOrEqual(4);
      expect(c.tools.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("every tool in the curated set is in the v2 surface (no answer_question, no hallucinated names)", () => {
    const c = curateV2Toolset(routeQuestion("M26057 vezérlése?", "hu"), "M26057 vezérlése?", "hu");
    for (const name of c.tools) {
      expect(V2_READ_TOOL_NAMES).toContain(name);
    }
    expect(c.tools).not.toContain("answer_question");
  });
});

describe("curateV2Toolset — assignment string is in the right language", () => {
  test("Hungarian assignment", () => {
    const c = curateV2Toolset(routeQuestion("M26057 vezérlése?", "hu"), "M26057 vezérlése?", "hu");
    expect(c.assignment).toContain("ELSŐDLEGES");
    expect(c.assignment).toContain("get_device_history");
  });

  test("English assignment", () => {
    const c = curateV2Toolset(routeQuestion("M26057 control", "en"), "M26057 control", "en");
    expect(c.assignment).toContain("PRIMARY");
    expect(c.assignment).toContain("get_device_history");
  });
});

describe("buildAgentToolsV2Subset — minimal schemas", () => {
  test("search_tickets in the subset has only q/include_evidence/limit/language", () => {
    const tools = buildAgentToolsV2Subset(["search_tickets"]);
    expect(tools).toHaveLength(1);
    const props = Object.keys(tools[0]!.props);
    // The minimal schema: no status, no period, no severity, no dates
    expect(props).not.toContain("status");
    expect(props).not.toContain("period");
    expect(props).not.toContain("sulyossag_inferred");
    expect(props).not.toContain("date_from");
    expect(props).not.toContain("date_to");
  });

  test("get_device_history in the subset has only device/limit/language", () => {
    const tools = buildAgentToolsV2Subset(["get_device_history"]);
    const props = Object.keys(tools[0]!.props);
    expect(props).not.toContain("status");
    expect(props).not.toContain("period");
  });

  test("subset with multiple names returns them in the order requested", () => {
    const tools = buildAgentToolsV2Subset(["find_ticket", "search_tickets", "get_device_history"]);
    expect(tools.map((t) => t.name)).toEqual(["find_ticket", "search_tickets", "get_device_history"]);
  });
});
