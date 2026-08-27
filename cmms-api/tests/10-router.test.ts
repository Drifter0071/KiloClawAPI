// Phase 1 router tests.
//
// Goal: confirm routeQuestion() returns the same plan for the same
// question, regardless of session. This is the single biggest
// consistency win of Phase 1 — these tests are the regression net.

import { test, expect, describe } from "bun:test";
import { routeQuestion, detectExplicitDates, contextualizeFollowUps } from "../src/lib/router";
import { familyFor, scoreOne } from "../src/lib/score";
import { routeQuestion, detectExplicitDates, contextualizeFollowUps } from "../src/lib/router";
import { familyFor, scoreOne } from "../src/lib/score";

describe("router: period detection", () => {
  test("English 'this month' -> this_month", () => {
    expect(routeQuestion("Melyik ügyfélhez járunk a legtöbbet this month?").period).toBe("this_month");
  });
  test("Hungarian 'tavaly' -> last_year", () => {
    expect(routeQuestion("Hány kritikus hiba volt tavaly?").period).toBe("last_year");
  });
  test("Hungarian 'utolsó 30 nap' -> last_30_days", () => {
    expect(routeQuestion("Melyik gép ment legtöbbször tönkre az utolsó 30 nap?").period).toBe("last_30_days");
  });
  test("Hungarian 'múlt hónap' -> last_month", () => {
    expect(routeQuestion("Hány ticket volt múlt hónapban?").period).toBe("last_month");
  });
  test("English 'YTD' -> YTD", () => {
    expect(routeQuestion("What's the YTD critical count?").period).toBe("YTD");
  });
  test("'all' / 'minden' -> all", () => {
    expect(routeQuestion("Melyik ügyfélhez járunk a legtöbbet minden eddig?").period).toBe("all");
  });
});

describe("router: customer / device / sorszam extraction", () => {
  test("extracts XYZ Kft.", () => {
    expect(routeQuestion("ANDRITZ Kft. összes ticketje").filters.customer).toContain("ANDRITZ");
  });
  test("extracts TMV-400", () => {
    expect(routeQuestion("Melyik a TMV-400 leggyakoribb hibája?").filters.device).toBe("TMV-400");
  });
  test("extracts explicit sorszam B25010615", () => {
    const plan = routeQuestion("Mi ez: B25010615?");
    expect(plan.intent).toBe("find_ticket_by_sorszam");
    expect(plan.filters.sorszam).toBe("B25010615");
  });
  test("extracts NCT104", () => {
    expect(routeQuestion("NCT104 szoftveres hibák").filters.device).toBe("NCT104");
  });
});

describe("router: top-N aggregations (the 65% problem)", () => {
  test("'melyik ügyfélhez járunk a legtöbbet' -> top_customers", () => {
    const plan = routeQuestion("Melyik ügyfélhez járunk a legtöbbet?");
    expect(plan.intent).toMatch(/^top_customers/);
    expect(plan.primitive).toBe("stats");
    expect(plan.group_by).toBe("customer");
    expect(plan.order).toBe("count_desc");
  });
  test("'melyik ügyfélhez járunk a legtöbbet idén' -> top_customers_in_period", () => {
    const plan = routeQuestion("Melyik ügyfélhez járunk a legtöbbet idén?");
    expect(plan.intent).toBe("top_customers_in_period");
    expect(plan.period).toBe("this_year");
  });
  test("'melyik ügyfélnek van a legtöbb nyitott ticketje' -> top_customer_open_tickets", () => {
    const plan = routeQuestion("Melyik ügyfélnek van a legtöbb nyitott ticketje?");
    expect(plan.intent).toBe("top_customer_open_tickets");
    expect(plan.filters.status).toBe("open");
  });
  test("'mennyi kritikus ticket van most' -> critical_open_now", () => {
    const plan = routeQuestion("Mennyi kritikus ticket van most?");
    expect(plan.intent).toBe("critical_open_now");
    expect(plan.filters.sulyossag_inferred).toBe("kritikus");
    expect(plan.filters.status).toBe("open");
  });
  test("'melyik gép megy legtöbbször tönkre' -> top_machine_type", () => {
    const plan = routeQuestion("Melyik gép megy legtöbbször tönkre?");
    expect(plan.intent).toBe("top_machine_type");
    expect(plan.group_by).toBe("machine_type");
  });
  test("'melyik gép hibásodik meg a legtöbbször' -> top_machine_type", () => {
    // Regression: the old router missed this phrasing, fell back to
    // free-text search with 0 hits, and answered "nem találtam".
    const plan = routeQuestion("Melyik gép hibásodik meg a legtöbbször?");
    expect(plan.intent).toBe("top_machine_type");
    expect(plan.group_by).toBe("machine_type");
  });
  test("'melyik gép hibásodott meg a leggyakrabban' -> top_machine_type (frequency guard)", () => {
    const plan = routeQuestion("Melyik gép hibásodott meg a leggyakrabban?");
    expect(plan.intent).toBe("top_machine_type");
  });
  test("'which machine breaks down most often' -> top_machine_type", () => {
    const plan = routeQuestion("Which machine breaks down most often?");
    expect(plan.intent).toBe("top_machine_type");
  });
  test("device-scoped frequency question still drills into the device", () => {
    // The !device guard on the new frequency trigger must not steal
    // device questions from the device drill-down branch.
    const plan = routeQuestion("Mi a leggyakoribb hibája az M26057 gépen?");
    expect(plan.intent).toBe("device_top_problem");
    expect(plan.filters.device).toBe("M26057");
  });
  test("'melyik gép hibásodik meg a legtöbbször' -> top_machine_type", () => {
    // Regression: the old router missed this phrasing, fell back to
    // free-text search with 0 hits, and answered "nem találtam".
    const plan = routeQuestion("Melyik gép hibásodik meg a legtöbbször?");
    expect(plan.intent).toBe("top_machine_type");
    expect(plan.group_by).toBe("machine_type");
  });
  test("'melyik gép hibásodott meg a leggyakrabban' -> top_machine_type (frequency guard)", () => {
    const plan = routeQuestion("Melyik gép hibásodott meg a leggyakrabban?");
    expect(plan.intent).toBe("top_machine_type");
  });
  test("'which machine breaks down most often' -> top_machine_type", () => {
    const plan = routeQuestion("Which machine breaks down most often?");
    expect(plan.intent).toBe("top_machine_type");
  });
  test("device-scoped frequency question still drills into the device", () => {
    // The !device guard on the new frequency trigger must not steal
    // device questions from the device drill-down branch.
    const plan = routeQuestion("Mi a leggyakoribb hibája az M26057 gépen?");
    expect(plan.intent).toBe("device_top_problem");
    expect(plan.filters.device).toBe("M26057");
  });
  test("'melyik vezérlő okozza a legtöbb hibát' -> top_controllers", () => {
    const plan = routeQuestion("Melyik vezérlő okozza a legtöbb hibát?");
    expect(plan.intent).toBe("top_controllers");
    expect(plan.group_by).toBe("controller");
  });
  test("'melyik a leggyakoribb hibakategória' -> top_kategoriak_inferred", () => {
    const plan = routeQuestion("Melyik a leggyakoribb hibakategória?");
    expect(plan.intent).toBe("top_kategoriak_inferred");
    expect(plan.group_by).toBe("kategoria_inferred");
  });
  test("'melyik a 10 legproblémásabb ügyfél' -> top 10", () => {
    const plan = routeQuestion("Melyik a 10 legproblémásabb ügyfél?");
    expect(plan.limit).toBe(10);
  });
});

describe("router: top_hubs word-boundary fix", () => {
  test("garbage 'Hubbbubbbla' must NOT route to top_hubs", () => {
    // Regression: "hub" was a plain substring needle, so any word merely
    // containing it (Hubbbubbbla) hit the top_hubs branch and produced
    // the nonsense "legtöbbször más ticket által hivatkozott munkák"
    // answer. It must fall through to the honest free-text fallback.
    const plan = routeQuestion("Hubbbubbbla");
    expect(plan.intent).not.toBe("top_hubs");
    expect(plan.intent).toBe("search_tickets");
    expect(plan.filters.q).toBe("Hubbbubbbla");
  });
  test("standalone 'hub' still routes to top_hubs", () => {
    expect(routeQuestion("hub").intent).toBe("top_hubs");
  });
  test("'show me the hub tickets' still routes to top_hubs", () => {
    expect(routeQuestion("show me the hub tickets").intent).toBe("top_hubs");
  });
  test("'melyik munkahoz jartunk ki a legtobbszor?' still routes to top_hubs", () => {
    expect(routeQuestion("melyik munkahoz jartunk ki a legtobbszor?").intent).toBe("top_hubs");
  });
});

describe("score: top_hubs family (no stats inflation)", () => {
  test("top_hubs belongs to find-pattern, not stats", () => {
    // Regression: the startsWith("top_") stats catch-all ran before the
    // find-pattern branch, giving top_hubs the inflated 0.30 base so it
    // outranked real searches as an alternate.
    expect(familyFor("top_hubs")).toBe("find-pattern");
  });
  test("top_hubs plan scores with the 0.20 fallback base", () => {
    const plan = routeQuestion("hub");
    expect(plan.intent).toBe("top_hubs");
    const { breakdown } = scoreOne(plan);
    expect(breakdown.base).toBe(0.2);
  });
});

describe("router: top_hubs word-boundary fix", () => {
  test("garbage 'Hubbbubbbla' must NOT route to top_hubs", () => {
    // Regression: "hub" was a plain substring needle, so any word merely
    // containing it (Hubbbubbbla) hit the top_hubs branch and produced
    // the nonsense "legtöbbször más ticket által hivatkozott munkák"
    // answer. It must fall through to the honest free-text fallback.
    const plan = routeQuestion("Hubbbubbbla");
    expect(plan.intent).not.toBe("top_hubs");
    expect(plan.intent).toBe("search_tickets");
    expect(plan.filters.q).toBe("Hubbbubbbla");
  });
  test("standalone 'hub' still routes to top_hubs", () => {
    expect(routeQuestion("hub").intent).toBe("top_hubs");
  });
  test("'show me the hub tickets' still routes to top_hubs", () => {
    expect(routeQuestion("show me the hub tickets").intent).toBe("top_hubs");
  });
  test("'melyik munkahoz jartunk ki a legtobbszor?' still routes to top_hubs", () => {
    expect(routeQuestion("melyik munkahoz jartunk ki a legtobbszor?").intent).toBe("top_hubs");
  });
});

describe("score: top_hubs family (no stats inflation)", () => {
  test("top_hubs belongs to find-pattern, not stats", () => {
    // Regression: the startsWith("top_") stats catch-all ran before the
    // find-pattern branch, giving top_hubs the inflated 0.30 base so it
    // outranked real searches as an alternate.
    expect(familyFor("top_hubs")).toBe("find-pattern");
  });
  test("top_hubs plan scores with the 0.20 fallback base", () => {
    const plan = routeQuestion("hub");
    expect(plan.intent).toBe("top_hubs");
    const { breakdown } = scoreOne(plan);
    expect(breakdown.base).toBe(0.2);
  });
});

describe("router: drill-down (single customer/device)", () => {
  test("customer name alone -> customer_tickets_list", () => {
    const plan = routeQuestion("Mutasd az ANDRITZ Kft. ticketjeit");
    expect(plan.intent).toBe("customer_tickets_list");
    expect(plan.filters.customer).toContain("ANDRITZ");
  });
  test("'mikor volt utoljára X-nél javítás' -> customer_last_seen", () => {
    const plan = routeQuestion("Mikor volt utoljára az ANDRITZ Kft.-nél javítás?");
    expect(plan.intent).toBe("customer_last_seen");
    expect(plan.filters.customer).toContain("ANDRITZ");
    expect(plan.order).toBe("recent_desc");
  });
  test("'milyen gépeket szervizelünk X-nél' -> customer_top_devices", () => {
    const plan = routeQuestion("Milyen gépeket szervizelünk az ANDRITZ Kft.-nél?");
    expect(plan.intent).toBe("customer_top_devices");
    expect(plan.group_by).toBe("machine_type");
  });
  test("'mi a baja ennek a gépnek' + device -> device_top_problem", () => {
    const plan = routeQuestion("Mi a baja ennek a TMV-400-nak?");
    expect(plan.intent).toBe("device_top_problem");
    expect(plan.filters.device).toBe("TMV-400");
    expect(plan.group_by).toBe("kategoria_inferred");
  });
});

describe("router: device + prose (Phase 5.1 regression)", () => {
  // Phase 1 stripped the free-text part whenever a device was extracted,
  // so "X tengely golyós orsó csapágyak típusa és mennyisége, M09192
  // munkánál" turned into a bare device filter and answered with a hit
  // counter. The part-spec intent (Phase 5.7) now routes it to
  // `part_spec` so the answer path can extract the type/quantity from
  // the work notes.
  test("device + part-spec prose -> part_spec with q set", () => {
    const plan = routeQuestion(
      "X tengely golyós orsó csapágyak típusa és mennyisége, M09192 munkánál",
    );
    expect(plan.intent).toBe("part_spec");
    expect(plan.primitive).toBe("search_tickets");
    expect(plan.filters.device).toBe("M09192");
    expect(plan.filters.q).toBeTruthy();
    // The leftover must not include the device token itself (avoid double-AND).
    expect(plan.filters.q!.toUpperCase()).not.toContain("M09192");
  });
  test("bare device identifier -> no q (no over-filtering)", () => {
    const plan = routeQuestion("M09192");
    expect(plan.intent).toBe("device_tickets_list");
    expect(plan.filters.device).toBe("M09192");
    expect(plan.filters.q).toBeUndefined();
  });
  test("device + 1 generic word -> no q (still too short)", () => {
    const plan = routeQuestion("M09192 ticketjei");
    expect(plan.intent).toBe("device_tickets_list");
    expect(plan.filters.device).toBe("M09192");
    expect(plan.filters.q).toBeUndefined();
  });
  test("device + multi-token prose + 'leggyakoribb' -> device_top_problem with q", () => {
    const plan = routeQuestion(
      "M09112 leggyakoribb hiba a tengely csapágynál",
    );
    expect(plan.intent).toBe("device_top_problem");
    expect(plan.filters.device).toBe("M09112");
    expect(plan.filters.q).toBeTruthy();
    expect(plan.filters.q!.toUpperCase()).not.toContain("M09112");
  });
});

describe("router: special intents", () => {
  test("'milyen kategóriák vannak' -> get_categories", () => {
    const plan = routeQuestion("Milyen kategóriák vannak?");
    expect(plan.intent).toBe("get_categories");
  });
  test("'melyik hiba tér vissza rendszeresen' -> find_pattern", () => {
    const plan = routeQuestion("Melyik hiba tér vissza rendszeresen?");
    expect(plan.intent).toBe("find_pattern");
  });
  test("'zárlatos motor a raktárban' -> find_spare_motor", () => {
    const plan = routeQuestion("Melyik motor zárlatos most a raktárban?");
    expect(plan.intent).toBe("find_spare_motor");
  });
  test("'meghibásodási arány 2024' -> failure_rates", () => {
    const plan = routeQuestion("Mekkora a DxC hajtások meghibásodási aránya 2024-ben?");
    expect(plan.intent).toBe("failure_rates");
  });
  test("'belső szerviz ticket' -> search_internal", () => {
    const plan = routeQuestion("Mutasd a szerviz belső ticketeket 2020-ból");
    expect(plan.intent).toBe("search_internal");
  });
});

describe("router: fallback", () => {
  test("vague 1-2 char question -> needs_clarification", () => {
    const plan = routeQuestion("?");
    expect(plan.intent).toBe("needs_clarification");
    expect(plan.follow_ups.length).toBeGreaterThan(0);
  });
  test("free-text fallback for unknown intent with 3+ chars", () => {
    const plan = routeQuestion("Y-tengely előtoló motor csere szükséges");
    expect(plan.intent).toBe("search_tickets");
    expect(plan.filters.q).toBeTruthy();
  });
});

describe("router: determinism (the Phase 1 promise)", () => {
  test("same question -> same plan, every time", () => {
    const q = "Melyik ügyfélhez járunk a legtöbbet az utolsó 30 napban?";
    const p1 = routeQuestion(q);
    const p2 = routeQuestion(q);
    expect(p1).toEqual(p2);
  });
  test("paraphrase of the same intent -> same plan (within intent family)", () => {
    const a = routeQuestion("Melyik ügyfélhez járunk a legtöbbet?");
    const b = routeQuestion("Ki a top ügyfelünk?");
    // Different exact intents are fine; the *primitive + group_by* must match.
    expect(a.primitive).toBe(b.primitive);
    expect(a.group_by).toBe(b.group_by);
  });
  test("English and Hungarian equivalents route to the same intent", () => {
    const hu = routeQuestion("Melyik ügyfélhez járunk a legtöbbet?");
    const en = routeQuestion("Which customer do we visit most?");
    expect(en.primitive).toBe(hu.primitive);
    expect(en.group_by).toBe(hu.group_by);
  });
});

describe("router: device-scoped customer questions (device_top_customers)", () => {
  // Regression: "Melyik ügyfélnél van belőle a legtöbb az M17191
  // gépen?" used to fall through to the GLOBAL top_customers answer
  // ("A legtöbb kiszállás minden idők: VÁMOSGÉP KFT. (62)") instead of
  // answering per-device. The router must scope to the device.
  test("the user's quick-select question routes to device_top_customers", () => {
    const plan = routeQuestion("Melyik ügyfélnél van belőle a legtöbb az M17191 gépen?");
    expect(plan.intent).toBe("device_top_customers");
    expect(plan.filters.device).toBe("M17191");
    expect(plan.group_by).toBe("customer");
  });
  test("the fixed chip text ('leggyakoribb') also routes to device_top_customers", () => {
    const plan = routeQuestion("Melyik ügyfélnél a leggyakoribb az M17191 gépen?");
    expect(plan.intent).toBe("device_top_customers");
    expect(plan.filters.device).toBe("M17191");
  });
  test("contextualized follow-ups carry the entity with correct grammar", () => {
    const plan = routeQuestion("Melyik ügyfélnél van belőle a legtöbb az M17191 gépen?");
    const fups = contextualizeFollowUps(plan, "hu");
    // The chip must exist, carry the device, and use the fixed phrasing
    // (no more "van belőle a legtöbb").
    expect(fups.length).toBeGreaterThan(0);
    expect(fups.some((f) => f.includes("M17191") && f.includes("leggyakoribb"))).toBe(true);
    expect(fups.some((f) => f.includes("van belőle"))).toBe(false);
  });
  test("follow-up suffix article follows the letter name (az M17191 gépen)", () => {
    const plan = routeQuestion("Milyen vezérlés található az M17191 gépen?");
    const fups = contextualizeFollowUps(plan, "hu");
    // M = "em" -> "az M17191 gépen" (not "a M17191 gépen").
    expect(fups.some((f) => f.includes("az M17191 gépen"))).toBe(true);
    expect(fups.some((f) => f.includes("a M17191 gépen"))).toBe(false);
  });
  test("sorszam follow-up suffix uses 'a <sorszam> munkánál'", () => {
    const plan = routeQuestion("Mi ez: B26071801?");
    const fups = contextualizeFollowUps(plan, "hu");
    expect(fups.some((f) => f.includes("a B26071801 munkánál"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Explicit date ranges (regression: "napjainktól 2024.05.10-ig
// visszamenőleg" used to be ignored and answered as "minden idők")
// ---------------------------------------------------------------------------

describe("router: explicit date ranges", () => {
  const NOW = new Date("2026-08-14T10:00:00Z");

  describe("detectExplicitDates unit", () => {
    test("hu 'napjainktól X-ig visszamenőleg' -> from=date, to=today", () => {
      expect(detectExplicitDates("napjainktól 2024.05.10-ig visszamenőleg", NOW)).toEqual({
        date_from: "2024-05-10",
        date_to: "2026-08-14",
      });
    });
    test("hu range '2024.01.01-től 2024.12.31-ig' -> both bounds", () => {
      expect(detectExplicitDates("2024.01.01-től 2024.12.31-ig", NOW)).toEqual({
        date_from: "2024-01-01",
        date_to: "2024-12-31",
      });
    });
    test("reversed two dates -> min/max ordering", () => {
      expect(detectExplicitDates("2024.12.31-ig, egészen 2024.01.01-től", NOW)).toEqual({
        date_from: "2024-01-01",
        date_to: "2024-12-31",
      });
    });
    test("en range 'from 2024-05-10 to 2024-06-01' -> both bounds", () => {
      expect(detectExplicitDates("from 2024-05-10 to 2024-06-01", NOW)).toEqual({
        date_from: "2024-05-10",
        date_to: "2024-06-01",
      });
    });
    test("en 'until 2024-05-10' (word before the date) -> date_to only", () => {
      expect(detectExplicitDates("until 2024-05-10", NOW)).toEqual({ date_to: "2024-05-10" });
    });
    test("en 'since 2024-05-10' -> date_from only", () => {
      expect(detectExplicitDates("tickets since 2024-05-10", NOW)).toEqual({ date_from: "2024-05-10" });
    });
    test("hu '2024.05.10-ig' -> date_to only", () => {
      expect(detectExplicitDates("egészen 2024.05.10-ig", NOW)).toEqual({ date_to: "2024-05-10" });
    });
    test("hu spaced '2024. 05. 10.' parses too", () => {
      expect(detectExplicitDates("napjainktól 2024. 05. 10.-ig visszamenőleg", NOW)).toEqual({
        date_from: "2024-05-10",
        date_to: "2026-08-14",
      });
    });
    test("year-only forms do NOT trigger ('2024-ben', '2025-ös')", () => {
      expect(detectExplicitDates("Melyik ügyfélhez rendeltünk 2024-ben FAG csapágyat?", NOW)).toBeUndefined();
      expect(detectExplicitDates("Foglald össze a 2025-ös helyzetet", NOW)).toBeUndefined();
    });
    test("sorszam-like 'SZÉV2024-262' does NOT trigger", () => {
      expect(detectExplicitDates("Ki a felelős a SZÉV2024-262-ért?", NOW)).toBeUndefined();
    });
    test("no date at all -> undefined", () => {
      expect(detectExplicitDates("Melyik ügyfélhez járunk a legtöbbet?", NOW)).toBeUndefined();
    });
  });

  describe("routeQuestion carries the window", () => {
    test("the M17191-style question gets period=custom + the window", () => {
      const plan = routeQuestion("napjainktól 2024.05.10-ig visszamenőleg M17191 vezérlés");
      expect(plan.period).toBe("custom");
      expect(plan.date_from).toBe("2024-05-10");
      // date_to = today (UTC) — same computation the router uses.
      const now = new Date();
      const todayIso = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
      expect(plan.date_to).toBe(todayIso);
      expect(plan.filters.device).toBe("M17191");
    });
    test("explicit dates win over named periods", () => {
      const plan = routeQuestion("Melyik ügyfélhez járunk a legtöbbet az utolsó 30 napban, 2024.01.01-től?");
      expect(plan.period).toBe("custom");
      expect(plan.date_from).toBe("2024-01-01");
    });
    test("no date -> no custom period overlay (named periods intact)", () => {
      const plan = routeQuestion("Hány kritikus hiba volt tavaly?");
      expect(plan.period).toBe("last_year");
      expect(plan.date_from).toBeUndefined();
      expect(plan.date_to).toBeUndefined();
    });
    test("no date -> no custom period overlay (no period at all)", () => {
      const plan = routeQuestion("Melyik ügyfélhez járunk a legtöbbet?");
      expect(plan.period).toBeUndefined();
      expect(plan.date_from).toBeUndefined();
      expect(plan.date_to).toBeUndefined();
    });
    test("determinism: date question -> same plan twice", () => {
      const q = "napjainktól 2024.05.10-ig visszamenőleg M17191 vezérlés";
      expect(routeQuestion(q)).toEqual(routeQuestion(q));
    });
  });
});

describe("router: display/screen symptom words (problem_solution)", () => {
  // The user's noun-phrase phrasing ("NCT204 sötét kijelző", "kijelző
  // hiba") never matched the old verb-only symptom set ("elsötétült")
  // and fell through to a bare hit counter ("7044 találat minden idők").
  // The added "sotet"/"kijelzo"/"kepernyo" words must route them to
  // problem_solution so the answer shows historical fixes.
  test("'NCT204 sötét kijelző' statement -> problem_solution with the symptom as q", () => {
    const plan = routeQuestion("NCT204 sötét kijelző");
    expect(plan.intent).toBe("problem_solution");
    expect(plan.filters.device).toBe("NCT204");
    expect(plan.filters.q).toContain("sötét kijelző");
  });
  test("'NCT204 kijelző hiba' (noun form, no verb) -> problem_solution", () => {
    const plan = routeQuestion("NCT204 kijelző hiba");
    expect(plan.intent).toBe("problem_solution");
    expect(plan.filters.device).toBe("NCT204");
  });
  test("'M26057 képernyő sötét' -> problem_solution (képernyő synonym)", () => {
    const plan = routeQuestion("M26057 képernyő sötét");
    expect(plan.intent).toBe("problem_solution");
    expect(plan.filters.device).toBe("M26057");
  });
  test("list request 'Mutasd a M26057 kijelző hibáit' stays a list (question leader)", () => {
    const plan = routeQuestion("Mutasd a M26057 kijelző hibáit");
    expect(plan.intent).not.toBe("problem_solution");
  });
  test("question form 'Milyen kijelző hibák voltak az M26057 gépen?' is not a symptom statement", () => {
    const plan = routeQuestion("Milyen kijelző hibák voltak az M26057 gépen?");
    expect(plan.intent).not.toBe("problem_solution");
  });
  test("attribute question stays on the attribute path despite 'kijelző' context", () => {
    const plan = routeQuestion("Milyen vezérlés található az M26057 gépen?");
    expect(plan.intent).toBe("device_tickets_list");
    expect(plan.filters.device).toBe("M26057");
  });
});
