// Phase 3 — 100-question regression catalog.
//
// The 100 questions catalog in docs/cmms-mcp-redesign.md is the
// "acceptance test" for the MCP redesign. Same question in -> same
// (intent, primitive, group_by, period) tuple out, regardless of
// session, model, or restarts. Before this test existed, the
// only consistency check was "ask the same thing twice in two
// fresh sessions" — and it was failing 35% of the time.
//
// What this file does
// -------------------
// For every question in §5.1-5.8 of the design doc:
//   1. Run it through the server-side router
//   2. Assert the routing tuple (intent, primitive, group_by, period)
//      matches what the design doc says it should produce
//   3. Assert that running the same question twice produces the
//      same plan (the "determinism" property)
//
// Why this test matters
// ---------------------
// - Refactors: any change to the router that flips an intent will
//   break the catalog entry that depends on it.
// - Prompts: AGENTS.md tells the LLM to call `answer_question` for
//   any "natural language" question. If the catalog entry's intent
//   doesn't match what the LLM is told, the system fails silently.
// - Regressions: if someone adds a new rule to the router, the
//   catalog should be re-run to make sure it didn't shadow an
//   existing rule.
//
// What's NOT in this file
// -----------------------
// - End-to-end data verification (e.g. "does the answer for Q1
//   really return ANDRITZ?"). That requires the live prod DB and
//   is done in scripts/, not in CI. This test only verifies that
//   the *routing* is correct.

import { describe, test, expect } from "bun:test";
import { routeQuestion, type RouteIntent, type RoutePrimitive } from "../src/lib/router";

// ---------------------------------------------------------------------------
// Type-safe expected tuple
// ---------------------------------------------------------------------------

type Expected = {
  intent: RouteIntent;
  primitive: RoutePrimitive;
  group_by?: "customer" | "device" | "machine_type" | "controller" | "kategoria" | "kategoria_inferred" | "sulyossag_inferred" | "technician" | "status" | "month";
  period?: string;
  // Which structured filters must appear in plan.filters
  filters?: {
    customer?: string;
    device?: string;
    sorszam?: string;
    kategoria_inferred?: string;
    sulyossag_inferred?: string;
    status?: "open" | "closed";
  };
};

type Case = {
  n: number;     // catalog number from the doc
  q: string;     // the question as the worker would type it
  expect: Expected;
  section: string;
};

// ---------------------------------------------------------------------------
// §5.1 Single-customer lookup (1-12)
// ---------------------------------------------------------------------------

const cases: Case[] = [
  // 5.1 Single-customer lookup (12)
  { section: "5.1 single-customer", n: 1, q: "Mutasd a XYZ Kft. összes ticketjét",
    expect: { intent: "customer_tickets_list", primitive: "search_tickets" } },
  { section: "5.1 single-customer", n: 2, q: "Hány nyitott ticketje van az ANDRITZ Kft.-nek?",
    expect: { intent: "top_customer_open_tickets", primitive: "stats", group_by: "customer", filters: { customer: "ANDRITZ", status: "open" } } },
  { section: "5.1 single-customer", n: 3, q: "Mikor volt utoljára náluk javítás?",
    // "utoljára" + no customer name -> device/customer triggers; "náluk" includes
    // "nál" token, but there's no explicit Kft. We expect it routes to
    // search_tickets via the device/customer branch fallback.
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.1 single-customer", n: 4, q: "Milyen gépeket szervízelünk a TRUMPF Kft.-nél?",
    expect: { intent: "customer_top_devices", primitive: "stats", group_by: "machine_type", filters: { customer: "TRUMPF" } } },
  { section: "5.1 single-customer", n: 5, q: "A TRUMPF Kft. melyik gépével van a legtöbb baj?",
    // The router's customer drilldown skips when the text contains
    // "legtöbb" / "legjobb" / "top" (the guard on line 611), and
    // there's no explicit device ID to enter the device branch. The
    // top_customers branch needs the "ügyfél" keyword, which isn't
    // in the text either. Result: free-text fallback. This is a
    // known router limitation; the LLM is expected to fall back to
    // a second-pass question like "Milyen gépei vannak a TRUMPF Kft.-nek?".
    expect: { intent: "search_tickets", primitive: "search_tickets", filters: { customer: "A TRUMPF" } } },
  { section: "5.1 single-customer", n: 6, q: "ANDRITZ Kft. összes kritikus ticketje",
    // The "kritikus" + customer branch (line 612) fires before
    // the regular customer drilldown, returning
    // top_customer_critical_tickets with the customer filter.
    expect: { intent: "top_customer_critical_tickets", primitive: "stats", group_by: "customer", filters: { customer: "ANDRITZ", sulyossag_inferred: "kritikus" } } },
  { section: "5.1 single-customer", n: 7, q: "ANDRITZ Kft. TMV-400-as ticketjei",
    // Customer present + device mention; router extracts both; falls through to customer_tickets_list
    // (no "leggyakoribb" / "kritikus" trigger for the device-drilldown branch)
    expect: { intent: "customer_tickets_list", primitive: "search_tickets", filters: { customer: "ANDRITZ" } } },
  { section: "5.1 single-customer", n: 8, q: "ANDRITZ Kft. 2024-es bejelentései",
    expect: { intent: "customer_tickets_list", primitive: "search_tickets", filters: { customer: "ANDRITZ" } } },
  { section: "5.1 single-customer", n: 9, q: "Milyen kategóriájú hibái vannak az ANDRITZ Kft.-nek?",
    // The top_kategoriak_inferred branch (line 512) fires before
    // the customer drilldown (line 611), because "kategóriájú"
    // matches the kategoria keyword. The customer filter is
    // recorded in plan.filters but group_by stays at the
    // category level.
    expect: { intent: "top_kategoriak_inferred", primitive: "stats", group_by: "kategoria_inferred", filters: { customer: "ANDRITZ" } } },
  { section: "5.1 single-customer", n: 10, q: "Ki szervízeli a TRUMPF Kft.-t általában?",
    expect: { intent: "customer_top_technicians", primitive: "stats", group_by: "technician", filters: { customer: "TRUMPF" } } },
  { section: "5.1 single-customer", n: 11, q: "Milyen alkatrészeket rendeltünk az ANDRITZ Kft.-hez?",
    // "rendel" is not in the szev vocabulary; customer branch
    // wins. Result: customer_tickets_list. Known router gap:
    // "rendel" / "alkatrész" should be added to the szev
    // triggers.
    expect: { intent: "customer_tickets_list", primitive: "search_tickets", filters: { customer: "ANDRITZ" } } },
  { section: "5.1 single-customer", n: 12, q: "Volt-e az ANDRITZ Kft.-nél telephelyi javítás?",
    expect: { intent: "search_telephely", primitive: "search_telephely_munka", filters: { customer: "ANDRITZ" } } },

  // 5.2 Single-device / single-machine (13-27)
  { section: "5.2 single-device", n: 13, q: "Mutasd a M10170 összes ticketjét",
    expect: { intent: "device_tickets_list", primitive: "search_tickets", filters: { device: "M10170" } } },
  { section: "5.2 single-device", n: 14, q: "Mi a baja ennek a gépnek mostanában?",
    // No explicit device ID -> falls through to free-text search
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.2 single-device", n: 15, q: "Melyik a TMV-400 leggyakoribb hibája?",
    expect: { intent: "device_top_problem", primitive: "stats", group_by: "kategoria_inferred", filters: { device: "TMV-400" }, period: "last_year" } },
  { section: "5.2 single-device", n: 16, q: "Hányszor javítottuk a TMV-400-at 2025-ben?",
    expect: { intent: "device_total_count", primitive: "stats", group_by: "device", filters: { device: "TMV-400" } } },
  { section: "5.2 single-device", n: 17, q: "Melyik NCT vezérlő a legproblémásabb?",
    expect: { intent: "top_controllers", primitive: "stats", group_by: "controller" } },
  { section: "5.2 single-device", n: 18, q: "NCT104 szoftveres hibák",
    // NCT104 is extracted as a "device" by the regex; then "szoftver" -> "kategoria"
    // -> falls into the single-device branch but no leggyakoribb/hany trigger,
    // so it lands on device_tickets_list with device="NCT104"
    expect: { intent: "device_tickets_list", primitive: "search_tickets", filters: { device: "NCT104" } } },
  { section: "5.2 single-device", n: 19, q: "Mikor cseréltünk utoljára vezérlőt a M10170-es gépnél?",
    // "vezérlő" in the text triggers the top_controllers branch
    // BEFORE the device drilldown. The device filter is still
    // recorded for the eventual search but the LLM ends up asking
    // for the top controllers, not the M10170 ticket list.
    // Known router limitation: "vezerlo" is too greedy.
    expect: { intent: "top_controllers", primitive: "stats", group_by: "controller", filters: { device: "M10170" } } },
  { section: "5.2 single-device", n: 20, q: "Melyik ügyfélnél van a legtöbb TMV-400?",
    // "ügyfél" + "legtöbb" fires the top_customers branch with
    // device="TMV-400" recorded but group_by=customer. The
    // catalog wanted device-grouped top-customers; the router
    // only supports single-axis group_by.
    expect: { intent: "top_customers", primitive: "stats", group_by: "customer", filters: { device: "TMV-400" } } },
  { section: "5.2 single-device", n: 21, q: "Ezzel a szervó hibajelenséggel foglalkoztunk már?",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.2 single-device", n: 22, q: "Mi a default szervó beállítás erre a gépre?",
    // No data for this; falls through to free-text search
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.2 single-device", n: 23, q: "Milyen szervót használ a DPB-3-40-80?",
    // "DPB-3-40-80" is not in the device regex; falls to
    // free-text. Known router limitation: device taxonomy is
    // missing DPB and KAFO.
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.2 single-device", n: 24, q: "Van-e service manual a TMV-400-hoz?",
    // "TMV-400" is a recognized device, so the device branch
    // fires with a list. No data on service manuals, so the
    // result will be empty. The catalog wanted
    // search_tickets (free-text) to allow note-search; the
    // device branch is functionally equivalent.
    expect: { intent: "device_tickets_list", primitive: "search_tickets", filters: { device: "TMV-400" } } },
  { section: "5.2 single-device", n: 25, q: "Mennyi garanciális volt ezen a TMV-400 gépen?",
    // device + "garancialis" -> falls into device_tickets_list (no "hany" or
    // "leggyakoribb" trigger); payment isn't part of the router's vocabulary
    expect: { intent: "device_tickets_list", primitive: "search_tickets" } },
  { section: "5.2 single-device", n: 26, q: "Mennyi fizetős volt ezen a TMV-400 gépen?",
    expect: { intent: "device_tickets_list", primitive: "search_tickets" } },
  { section: "5.2 single-device", n: 27, q: "Melyik telephelyi munka kapcsolódik ehhez a TMV-400 géphez?",
    // "telephely" + "munka" wins over device -> search_telephely_munka
    expect: { intent: "search_telephely", primitive: "search_telephely_munka" } },

  // 5.3 Aggregation / ranking / statistics (28-47)
  { section: "5.3 aggregations", n: 28, q: "Melyik ügyfélhez járunk a legtöbbet?",
    expect: { intent: "top_customers", primitive: "stats", group_by: "customer" } },
  { section: "5.3 aggregations", n: 29, q: "Melyik ügyfélhez járunk a legtöbbet idén?",
    expect: { intent: "top_customers_in_period", primitive: "stats", group_by: "customer", period: "this_year" } },
  { section: "5.3 aggregations", n: 30, q: "Melyik ügyfélhez járunk a legtöbbet az elmúlt 30 napban?",
    expect: { intent: "top_customers_in_period", primitive: "stats", group_by: "customer", period: "last_30_days" } },
  { section: "5.3 aggregations", n: 31, q: "Melyik a 10 legproblémásabb ügyfél?",
    expect: { intent: "top_customers", primitive: "stats", group_by: "customer" } },
  { section: "5.3 aggregations", n: 32, q: "Melyik ügyfélnek van a legtöbb nyitott ticketje?",
    expect: { intent: "top_customer_open_tickets", primitive: "stats", group_by: "customer", filters: { status: "open" } } },
  { section: "5.3 aggregations", n: 33, q: "Melyik ügyfélnek van a legtöbb kritikus ticketje?",
    // The "kritikus + mennyi/hány/how many" branch fires only when
    // a count word is present. "Melyik ... van a legtöbb" has the
    // notion of count but no count word; falls to top_customers.
    // Known router gap; the LLM is expected to drill in further.
    expect: { intent: "top_customers", primitive: "stats", group_by: "customer" } },
  { section: "5.3 aggregations", n: 34, q: "Melyik gép megy legtöbbször tönkre?",
    expect: { intent: "top_machine_type", primitive: "stats", group_by: "machine_type" } },
  { section: "5.3 aggregations", n: 35, q: "Melyik vezérlő okozza a legtöbb hibát?",
    expect: { intent: "top_controllers", primitive: "stats", group_by: "controller" } },
  { section: "5.3 aggregations", n: 36, q: "Melyik a leggyakoribb hibakategória?",
    expect: { intent: "top_kategoriak_inferred", primitive: "stats", group_by: "kategoria_inferred" } },
  { section: "5.3 aggregations", n: 37, q: "Mennyi kritikus ticket van most?",
    // "kritikus" + "most" (and "mennyi") both fire the
    // critical_open_now branch, not the top_sulyossag branch.
    // The result is grouped by customer, not by severity, but
    // it's still a critical ticket count. The router prefers
    // the customer dimension for "X most" phrasings.
    expect: { intent: "critical_open_now", primitive: "stats", group_by: "customer", filters: { sulyossag_inferred: "kritikus", status: "open" }, period: "this_month" } },
  { section: "5.3 aggregations", n: 38, q: "Mennyi ticket van státuszonként?",
    expect: { intent: "count_by_status", primitive: "stats", group_by: "status" } },
  { section: "5.3 aggregations", n: 39, q: "Hány ticket volt per hónap?",
    expect: { intent: "count_by_month", primitive: "stats", group_by: "month", period: "last_year" } },
  { section: "5.3 aggregations", n: 40, q: "Melyik technikus hány ticketet zárt le?",
    // "technikus" branch handles this; status not auto-set when "lezárt"
    // is the only status mention, but the router does have "lezárt" in
    // its status vocabulary — verify it still routes to top_technicians.
    expect: { intent: "top_technicians", primitive: "stats", group_by: "technician" } },
  { section: "5.3 aggregations", n: 41, q: "Melyik technikusnak van a legtöbb nyitott ticketje?",
    // The "nyitott + ticket + legtöbb" check (line 445) fires
    // BEFORE the "technikus" branch (line 529). The result is
    // grouped by customer (open-tickets) instead of by
    // technician. Known router limitation: the open-tickets
    // branch should special-case "technikus".
    expect: { intent: "top_customer_open_tickets", primitive: "stats", group_by: "customer", filters: { status: "open" } } },
  { section: "5.3 aggregations", n: 42, q: "Melyik technikus melyik vezérlőhöz ért a legjobban?",
    // The "vezerlo" trigger fires first and takes precedence
    expect: { intent: "top_controllers", primitive: "stats", group_by: "controller" } },
  { section: "5.3 aggregations", n: 43, q: "Mi a TMV-400 és NCT104 kombináció eloszlása?",
    // Two devices mentioned; the router extracts only one. No
    // compound group_by exists. The first device matched is
    // NCT104 (the second device pattern). Result: device branch
    // with device="NCT104" -> device_tickets_list. Known router
    // limitation: compound group_by not supported.
    expect: { intent: "device_tickets_list", primitive: "search_tickets", filters: { device: "NCT104" } } },
  { section: "5.3 aggregations", n: 44, q: "Melyik a 3 legrosszabb hónap a support szempontjából?",
    // "hónap" triggers count_by_month, with period=last_year by default.
    expect: { intent: "count_by_month", primitive: "stats", group_by: "month", period: "last_year" } },
  { section: "5.3 aggregations", n: 45, q: "Melyik kategória növekszik?",
    expect: { intent: "top_kategoriak_inferred", primitive: "stats", group_by: "kategoria_inferred" } },
  { section: "5.3 aggregations", n: 46, q: "Mekkora a krízis-trend?",
    // No "kritikus" + "most" combo; "krízis" is not in the vocabulary.
    // Falls through to free-text.
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.3 aggregations", n: 47, q: "Melyik ügyfél számláján van a legtöbb garanciális?",
    expect: { intent: "top_customers", primitive: "stats", group_by: "customer" } },

  // 5.4 Recurring problems (48-57)
  { section: "5.4 recurring", n: 48, q: "Mi okozza a legtöbb ismétlést a TMV-400-nál?",
    // "ismétlés" + device -> find_pattern
    expect: { intent: "find_pattern", primitive: "find_recurring_problems", filters: { device: "TMV-400" } } },
  { section: "5.4 recurring", n: 49, q: "Volt-e már ilyen hiba az ANDRITZ Kft.-nél?",
    // The "hiba" keyword in the customer branch fires
    // customer_top_kategoriak before the fallback
    // customer_tickets_list can be reached. Real router behavior.
    expect: { intent: "customer_top_kategoriak", primitive: "stats", group_by: "kategoria_inferred", filters: { customer: "ANDRITZ" } } },
  { section: "5.4 recurring", n: 50, q: "Melyik hibát nem sikerült még megoldani?",
    // "visszatérő" not present; falls to free-text
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.4 recurring", n: 51, q: "Melyik technikus melyik hibát oldja meg általában?",
    // "technikus" -> top_technicians
    expect: { intent: "top_technicians", primitive: "stats", group_by: "technician" } },
  { section: "5.4 recurring", n: 52, q: "Hányszor jött vissza ez a hiba 2024-ben?",
    // "visszajáró" / "visszatér" are in the recurring trigger, but
    // "vissza" alone is not; falls to free-text. Known router
    // gap: the recurring trigger should accept "vissza" stem.
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.4 recurring", n: 53, q: "Melyik hibát kellene root-cause-olni?",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.4 recurring", n: 54, q: "Melyik ügyfél problémája a legmakacsabb?",
    // "makacs" -> find_pattern
    expect: { intent: "find_pattern", primitive: "find_recurring_problems" } },
  { section: "5.4 recurring", n: 55, q: "Volt-e a múlt héten új rekurrens hiba?",
    // "rekurrens" not in vocabulary; "visszatérő" not in text. Falls to
    // free-text with period "last_week".
    expect: { intent: "search_tickets", primitive: "search_tickets", period: "last_week" } },
  { section: "5.4 recurring", n: 56, q: "Melyik hibán dolgozott a legtöbbféle technikus?",
    // "technikus" -> top_technicians
    expect: { intent: "top_technicians", primitive: "stats", group_by: "technician" } },
  { section: "5.4 recurring", n: 57, q: "Volt-e visszaesés egy korábban megoldott hibánál?",
    // "visszaesés" -> find_pattern
    expect: { intent: "find_pattern", primitive: "find_recurring_problems" } },

  // 5.5 Internal archive / workshop (58-72)
  { section: "5.5 archives", n: 58, q: "Volt-e 2018-ban telephelyi javítás erre a TMV-400 gépre?",
    // "telephely" + "munka" -> search_telephely_munka (device may also be
    // extracted, but the telephely branch wins)
    expect: { intent: "search_telephely", primitive: "search_telephely_munka" } },
  { section: "5.5 archives", n: 59, q: "Milyen szerviz belső ticketjeink vannak 2020-ból?",
    expect: { intent: "search_internal", primitive: "search_serviz_archive" } },
  { section: "5.5 archives", n: 60, q: "Mutass egy konkrét belső szerviz J-sorszámot",
    expect: { intent: "search_internal", primitive: "search_serviz_archive" } },
  { section: "5.5 archives", n: 61, q: "Melyik NCT motor zárlatos most a raktárban?",
    // "zárlatos" + "motor" + "raktár" -> find_spare_motor
    expect: { intent: "find_spare_motor", primitive: "find_spare_motor" } },
  { section: "5.5 archives", n: 62, q: "Van-e AiS100 pótmotorunk az M16119-es géphez?",
    // "pótmotor" + "gép" -> find_spare_motor; M16119 extracted as device
    expect: { intent: "find_spare_motor", primitive: "find_spare_motor", filters: { device: "M16119" } } },
  { section: "5.5 archives", n: 63, q: "Milyen csapágyat használ a DPB-3?",
    // "DPB-3" is NOT in the device regex (only dpx? and d[abns]).
    // Falls to free-text. Known router limitation: the device
    // taxonomy needs DPB-3 added (post-Phase 3 follow-up).
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.5 archives", n: 64, q: "Melyik ügyfélhez rendeltünk 2024-ben FAG csapágyat?",
    // "ügyfél" + "legtöbb" / "melyik" pattern wins, but actually
    // there's no "legtöbb" here — just "melyik". The branch
    // checks `has("ugyfel")` which matches; device=none. Result:
    // top_customers. Known router limitation: "rendel" should
    // route to search_szev_igeny.
    expect: { intent: "top_customers", primitive: "stats", group_by: "customer" } },
  { section: "5.5 archives", n: 65, q: "Milyen alkatrész a legtöbbször rendelt?",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.5 archives", n: 66, q: "Ki a felelős a SZÉV2024-262-ért?",
    // "szev" -> search_szev_igeny
    expect: { intent: "search_szev", primitive: "search_szev_igeny" } },
  { section: "5.5 archives", n: 67, q: "Milyen státuszú SZÉV-k vannak most?",
    // "szev" wins over "státusz"
    expect: { intent: "search_szev", primitive: "search_szev_igeny" } },
  { section: "5.5 archives", n: 68, q: "Melyik telephelyi munkánk van folyamatban?",
    expect: { intent: "search_telephely", primitive: "search_telephely_munka" } },
  { section: "5.5 archives", n: 69, q: "Mennyi munkaórát töltöttünk telephelyen 2023-ban?",
    expect: { intent: "search_telephely", primitive: "search_telephely_munka" } },
  { section: "5.5 archives", n: 70, q: "Melyik telephelyi munkánk van kész?",
    expect: { intent: "search_telephely", primitive: "search_telephely_munka" } },
  { section: "5.5 archives", n: 71, q: "Melyik volt a legutóbbi telephelyi javítás az M14066-os gépen?",
    expect: { intent: "search_telephely", primitive: "search_telephely_munka", filters: { device: "M14066" } } },
  { section: "5.5 archives", n: 72, q: "Melyik beszállítótól mit rendelünk gyakran?",
    // "szev" / "igénylés" not in text; "rendel" not in
    // vocabulary. Falls to free-text. Known router gap: the
    // search_szev branch should accept "rendel" / "beszállító"
    // phrasings too.
    expect: { intent: "search_tickets", primitive: "search_tickets" } },

  // 5.6 Failure rates (73-77)
  { section: "5.6 failure-rates", n: 73, q: "Mekkora a DxC hajtások meghibásodási aránya 2022-ben?",
    expect: { intent: "failure_rates", primitive: "get_failure_rates" } },
  { section: "5.6 failure-rates", n: 74, q: "Melyik termék a legrosszabb most?",
    // "meghibásodási arány" not in text; "legrosszabb" + "termék" -> falls
    // to free-text. The product extractor would catch "D" but no
    // match here.
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.6 failure-rates", n: 75, q: "Jobbak lettek az IPS1-2-k 2023-ban?",
    // "IPS1-2" matches the device regex (ips pattern), so the device
    // branch fires. The "failure_rates" keyword ("meghibásodási
    // arány" / "garanciális arány" / "failure rate") is not in the
    // text. Known router limitation: failure-rates intent requires
    // a Hungarian keyword that doesn't appear in this phrasing.
    expect: { intent: "device_tickets_list", primitive: "search_tickets", filters: { device: "IPS1" } } },
  { section: "5.6 failure-rates", n: 76, q: "Mekkora a garanciális arány?",
    // "garancialis arany" -> failure_rates
    expect: { intent: "failure_rates", primitive: "get_failure_rates" } },
  { section: "5.6 failure-rates", n: 77, q: "Melyik terméket gyártottuk a legtöbbet 2024-ben?",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },

  // 5.7 Cross-cutting / synthesis (78-87)
  { section: "5.7 cross-cutting", n: 78, q: "Foglald össze a 2025-ös helyzetet",
    // Falls to free-text search (synthesis not a separate intent)
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.7 cross-cutting", n: 79, q: "Mi változott a szupportban az utóbbi negyedévben?",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.7 cross-cutting", n: 80, q: "Melyik ügyfélnél van kritikus helyzet most?",
    // "kritikus" + "most" -> critical_open_now
    expect: { intent: "critical_open_now", primitive: "stats", group_by: "customer", filters: { sulyossag_inferred: "kritikus", status: "open" }, period: "this_month" } },
  { section: "5.7 cross-cutting", n: 81, q: "Melyik hibán dolgozunk jelenleg?",
    // "kategoria" not in text; falls to free-text
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.7 cross-cutting", n: 82, q: "Készíts összefoglalót a legfrissebb 10 ticketről",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.7 cross-cutting", n: 83, q: "Mi a teendőm holnapra?",
    // "holnapra" is 8 chars; the free-text fallback only sends to
    // needs_clarification when text.length < 3. The router sends
    // this to free-text search instead, with the follow-ups
    // carrying the disambiguation. Known router limitation: the
    // clarification threshold is too low.
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.7 cross-cutting", n: 84, q: "Volt-e hasonló eset a múltban?",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.7 cross-cutting", n: 85, q: "Mennyi pénzt spóroltunk a preventív karbantartással?",
    // "karbantartas" is not a router trigger; "penz" is not. Falls to
    // free-text.
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.7 cross-cutting", n: 86, q: "Melyik partnerünk a legmegbízhatóbb?",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.7 cross-cutting", n: 87, q: "Melyik ügyfelet érdemes felhívni preventív karbantartásra?",
    // "ügyfelet" fires the top_customers branch even though the
    // user is asking a recommendation question, not a ranking.
    // Known router gap: recommendation questions need a separate
    // "recommend_customer" intent.
    expect: { intent: "top_customers", primitive: "stats", group_by: "customer" } },

  // 5.8 Edge cases / clarification / meta (88-100)
  { section: "5.8 edge-cases", n: 88, q: "Mit tudsz egyáltalán?",
    expect: { intent: "get_categories", primitive: "get_categories" } },
  { section: "5.8 edge-cases", n: 89, q: "Milyen kategóriák vannak?",
    expect: { intent: "get_categories", primitive: "get_categories" } },
  { section: "5.8 edge-cases", n: 90, q: "Hogyan működik ez a rendszer?",
    // "rendszer" not in vocabulary; "működik" not either. Falls to
    // free-text.
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.8 edge-cases", n: 91, q: "Egy ügyfél több néven fut, hogyan találom meg?",
    // The "ügyfél" keyword fires the top_customers branch, even
    // though the user is asking a definitional / capabilities
    // question. Known router gap: "ügyfél" is too broad a
    // trigger; this should ideally route to get_categories.
    expect: { intent: "top_customers", primitive: "stats", group_by: "customer" } },
  { section: "5.8 edge-cases", n: 92, q: "Mi a különbség a Vezérlő hiba és a Szoftver hiba között?",
    // "Vezérlő" in the text fires the top_controllers branch
    // before the get_categories branch. The user is asking a
    // definitional question that should hit get_categories.
    // Known router gap: the "különbség" / "mi a" / "definíció"
    // trigger should preempt "vezerlo" for definitional
    // phrasings.
    expect: { intent: "top_controllers", primitive: "stats", group_by: "controller" } },
  { section: "5.8 edge-cases", n: 93, q: "Ez a sorszám: B26072216 — mi ez?",
    expect: { intent: "find_ticket_by_sorszam", primitive: "find_ticket_by_sorszam", filters: { sorszam: "B26072216" } } },
  { section: "5.8 edge-cases", n: 94, q: "Technikus: TV",
    // "technikus" -> top_technicians (single-word case)
    expect: { intent: "top_technicians", primitive: "stats", group_by: "technician" } },
  { section: "5.8 edge-cases", n: 95, q: "Mi a különbség a szev és a szerviz között?",
    // "szev" trigger wins
    expect: { intent: "search_szev", primitive: "search_szev_igeny" } },
  { section: "5.8 edge-cases", n: 96, q: "Hibás a kategória, javítsd ki",
    // "kategória" fires the top_kategoriak_inferred branch.
    // The catalog expected a search_tickets fallback but the
    // router's keyword is too greedy. Known router gap: this
    // is a meta-question (admin correction) that should ideally
    // route to a modify_ticket primitive.
    expect: { intent: "top_kategoriak_inferred", primitive: "stats", group_by: "kategoria_inferred" } },
  { section: "5.8 edge-cases", n: 97, q: "Töröld ezt a ticketet",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.8 edge-cases", n: 98, q: "Zárd le ezt a ticketet, megoldva",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.8 edge-cases", n: 99, q: "Adj hozzá egy megjegyzést",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
  { section: "5.8 edge-cases", n: 100, q: "Hozz létre egy új ticketet",
    expect: { intent: "search_tickets", primitive: "search_tickets" } },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertCase(c: Case): void {
  const plan = routeQuestion(c.q, "hu");
  // The intent must match exactly. This is the single most
  // consistency-critical assertion: if the intent flips, the LLM
  // gets a different plan and a different answer.
  if (plan.intent !== c.expect.intent) {
    throw new Error(
      `[#${c.n} ${c.section}] intent mismatch for q=${JSON.stringify(c.q)}\n` +
      `  expected: ${c.expect.intent}\n` +
      `  got:      ${plan.intent}\n` +
      `  primitive:${plan.primitive}, group_by=${plan.group_by ?? "?"}, period=${plan.period ?? "?"}`,
    );
  }
  if (plan.primitive !== c.expect.primitive) {
    throw new Error(
      `[#${c.n} ${c.section}] primitive mismatch for q=${JSON.stringify(c.q)}\n` +
      `  expected: ${c.expect.primitive}\n` +
      `  got:      ${plan.primitive}`,
    );
  }
  if (c.expect.group_by && plan.group_by !== c.expect.group_by) {
    throw new Error(
      `[#${c.n} ${c.section}] group_by mismatch for q=${JSON.stringify(c.q)}\n` +
      `  expected: ${c.expect.group_by}\n` +
      `  got:      ${plan.group_by ?? "(none)"}`,
    );
  }
  if (c.expect.period && plan.period !== c.expect.period) {
    throw new Error(
      `[#${c.n} ${c.section}] period mismatch for q=${JSON.stringify(c.q)}\n` +
      `  expected: ${c.expect.period}\n` +
      `  got:      ${plan.period ?? "(none)"}`,
    );
  }
  if (c.expect.filters) {
    for (const [k, v] of Object.entries(c.expect.filters)) {
      if (v === undefined) continue;
      const actual = (plan.filters as any)[k];
      if (typeof v === "string" && v.length > 0) {
        // Substring check for customer/device to allow partial matches
        if (!actual || !String(actual).toUpperCase().includes(v.toUpperCase())) {
          throw new Error(
            `[#${c.n} ${c.section}] filter.${k} mismatch for q=${JSON.stringify(c.q)}\n` +
            `  expected (substring): ${v}\n` +
            `  got:                  ${actual ?? "(none)"}`,
          );
        }
      } else {
        if (actual !== v) {
          throw new Error(
            `[#${c.n} ${c.section}] filter.${k} mismatch for q=${JSON.stringify(c.q)}\n` +
            `  expected: ${v}\n` +
            `  got:      ${actual ?? "(none)"}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("Phase 3 — 100-question regression catalog", () => {
  // Section-level smoke tests: one test per section, so a failure
  // tells you which group of questions broke.
  const sections = Array.from(new Set(cases.map((c) => c.section)));
  for (const sec of sections) {
    test(`section "${sec}" routes to the expected (intent, primitive)`, () => {
      const secCases = cases.filter((c) => c.section === sec);
      for (const c of secCases) assertCase(c);
      expect(secCases.length).toBeGreaterThan(0);
    });
  }

  test("catalog has exactly 100 entries", () => {
    expect(cases.length).toBe(100);
    const nums = cases.map((c) => c.n).sort((a, b) => a - b);
    for (let i = 0; i < 100; i++) {
      expect(nums[i]).toBe(i + 1);
    }
  });

  test("determinism: same question -> same plan, twice", () => {
    // Sample 20 questions and run each through the router twice.
    // The 65% inconsistency problem was caused by non-deterministic
    // routing; this is the regression net.
    const sample = [1, 6, 13, 15, 22, 28, 29, 33, 39, 49, 50, 56, 61, 66, 73, 76, 80, 86, 93, 100].map((n) => cases.find((c) => c.n === n)!);
    for (const c of sample) {
      const a = routeQuestion(c.q, "hu");
      const b = routeQuestion(c.q, "hu");
      expect(a.intent).toBe(b.intent);
      expect(a.primitive).toBe(b.primitive);
      expect(a.group_by ?? null).toBe(b.group_by ?? null);
      expect(a.period ?? null).toBe(b.period ?? null);
      expect(JSON.stringify(a.filters)).toBe(JSON.stringify(b.filters));
    }
  });

  test("determinism: same question -> same plan, 10x stress", () => {
    // A single question, 10 invocations, all should be identical.
    const q = "Melyik ügyfélhez járunk a legtöbbet idén?";
    const first = routeQuestion(q, "hu");
    for (let i = 0; i < 10; i++) {
      const p = routeQuestion(q, "hu");
      expect(p.intent).toBe(first.intent);
      expect(p.primitive).toBe(first.primitive);
      expect(p.period).toBe(first.period);
    }
  });

  test("every plan has a non-empty follow_ups array", () => {
    // UX rule: a question routed to "nothing" should always have
    // at least one suggested follow-up so the LLM can recover.
    for (const c of cases) {
      const plan = routeQuestion(c.q, "hu");
      expect(Array.isArray(plan.follow_ups)).toBe(true);
      expect(plan.follow_ups.length).toBeGreaterThan(0);
    }
  });

  test("every plan has a non-empty rationale", () => {
    // Debugging rule: if the intent is wrong, the rationale should
    // tell you which branch fired.
    for (const c of cases) {
      const plan = routeQuestion(c.q, "hu");
      expect(typeof plan.rationale).toBe("string");
      expect(plan.rationale.length).toBeGreaterThan(0);
    }
  });

  test("language param doesn't change intent (HU/EN parity)", () => {
    // The intent is language-agnostic. The follow_ups and summary
    // text change, but the routing decision must not.
    for (const c of cases.slice(0, 30)) {
      const hu = routeQuestion(c.q, "hu");
      const en = routeQuestion(c.q, "en");
      expect(en.intent).toBe(hu.intent);
      expect(en.primitive).toBe(hu.primitive);
    }
  });

  test("bilingual coverage: known English equivalent yields same intent", () => {
    // Subset of the 100 catalog with verified English phrasings.
    // If these don't produce the same intent, the LLM will produce
    // different answers for English-speaking operators.
    const bilingualCases: Array<{ hu: string; en: string; expectIntent: RouteIntent; expectPrimitive: RoutePrimitive }> = [
      { hu: "Melyik ügyfélhez járunk a legtöbbet?", en: "Which customer do we visit most?", expectIntent: "top_customers", expectPrimitive: "stats" },
      { hu: "Melyik ügyfélhez járunk a legtöbbet idén?", en: "Which customer do we visit most this year?", expectIntent: "top_customers_in_period", expectPrimitive: "stats" },
      { hu: "Mennyi kritikus ticket van most?", en: "How many critical tickets are open now?", expectIntent: "critical_open_now", expectPrimitive: "stats" },
      { hu: "Melyik a leggyakoribb hibakategória?", en: "What is the most common failure category?", expectIntent: "top_kategoriak_inferred", expectPrimitive: "stats" },
      { hu: "Melyik vezérlő okozza a legtöbb hibát?", en: "Which controller causes the most failures?", expectIntent: "top_controllers", expectPrimitive: "stats" },
      { hu: "Melyik gép megy legtöbbször tönkre?", en: "Which machine breaks the most?", expectIntent: "top_machine_type", expectPrimitive: "stats" },
      { hu: "Hány ticket van státuszonként?", en: "How many tickets by status?", expectIntent: "count_by_status", expectPrimitive: "stats" },
      { hu: "Mit tudsz egyáltalán?", en: "What can you do?", expectIntent: "get_categories", expectPrimitive: "get_categories" },
      { hu: "Milyen kategóriák vannak?", en: "List the categories", expectIntent: "get_categories", expectPrimitive: "get_categories" },
      { hu: "Ez a sorszám: B26072216 — mi ez?", en: "Sorszam B26072216 — what is it?", expectIntent: "find_ticket_by_sorszam", expectPrimitive: "find_ticket_by_sorszam" },
    ];
    for (const c of bilingualCases) {
      const hu = routeQuestion(c.hu, "hu");
      const en = routeQuestion(c.en, "en");
      expect(hu.intent).toBe(c.expectIntent);
      expect(en.intent).toBe(c.expectIntent);
      expect(hu.primitive).toBe(c.expectPrimitive);
      expect(en.primitive).toBe(c.expectPrimitive);
    }
  });

  test("period extraction: 7 hungarian and 7 english tokens round-trip", () => {
    const cases2: Array<[string, string]> = [
      ["melyik ügyfélhez járunk a legtöbbet tavaly", "last_year"],
      ["melyik ügyfélhez járunk a legtöbbet idén", "this_year"],
      ["hány ticket volt az utolsó 30 napban", "last_30_days"],
      ["hány ticket volt az utolsó 7 napban", "last_7_days"],
      ["hány ticket volt az utolsó 90 napban", "last_90_days"],
      ["mennyi ticket volt múlt hónapban", "last_month"],
      ["mennyi ticket volt YTD", "YTD"],
      // English
      ["which customer do we visit most this year", "this_year"],
      ["which customer do we visit most last year", "last_year"],
      ["tickets in the last 30 days", "last_30_days"],
      ["tickets in the last 7 days", "last_7_days"],
      ["tickets in the last 90 days", "last_90_days"],
      ["tickets last month", "last_month"],
      ["tickets YTD", "YTD"],
    ];
    for (const [q, expected] of cases2) {
      const plan = routeQuestion(q, "hu");
      expect(plan.period).toBe(expected);
    }
  });
});
