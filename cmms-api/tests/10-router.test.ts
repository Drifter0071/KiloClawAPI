// Phase 1 router tests.
//
// Goal: confirm routeQuestion() returns the same plan for the same
// question, regardless of session. This is the single biggest
// consistency win of Phase 1 — these tests are the regression net.

import { test, expect, describe } from "bun:test";
import { routeQuestion } from "../src/lib/router";

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
  test("'milyen gépeket szervízelünk X-nél' -> customer_top_devices", () => {
    const plan = routeQuestion("Milyen gépeket szervízelünk az ANDRITZ Kft.-nél?");
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
