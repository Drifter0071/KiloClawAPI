// src/lib/agent_tools.ts
//
// Tool registry for the agentic Ask loop (POST /v1/answer-agent).
//
// This is the compact, LLM-facing mirror of the MCP tool surface
// (mcp-server.ts). Every tool maps 1:1 to a REST endpoint on the
// cmms-api process itself (self-fetch, same execution contract as
// mcp-server.ts's call()/guardedCall()).
//
// DELIBERATELY EXCLUDED:
//   - remove_ticket            — permanent, irreversible DB delete. Stays
//                                OUT of the agent's toolset (non-negotiable).
//   - search_existing_tickets  — legacy alias of search_tickets (same
//                                endpoint); a duplicate confuses the LLM.
//   - search_by_category       — legacy fast-path subset of search_tickets
//                                (same endpoint, kategoria filter).
// 25 tools total: 19 read + 6 write.

// ---------------------------------------------------------------------------
// Param spec + JSON-schema expansion (OpenAI `tools` format)
// ---------------------------------------------------------------------------

type ParamSpec =
  | { t: "string"; d: string; e?: string[]; r?: boolean }
  | { t: "integer"; d: string; r?: boolean }
  | { t: "boolean"; d: string; r?: boolean }
  | { t: "string-array"; d: string; r?: boolean };

function schema(props: Record<string, ParamSpec>): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(props)) {
    let js: Record<string, unknown>;
    switch (spec.t) {
      case "integer":
        js = { type: "integer" };
        break;
      case "boolean":
        js = { type: "boolean" };
        break;
      case "string-array":
        js = { type: "array", items: { type: "string" } };
        break;
      default:
        js = { type: "string" };
        if (spec.e && spec.e.length > 0) js.enum = spec.e;
    }
    js.description = spec.d;
    properties[name] = js;
    if (spec.r) required.push(name);
  }
  return { properties, required };
}

export type AgentToolDef = {
  name: string;
  /** Bilingual description the LLM reads when picking a tool. */
  description: string;
  props: Record<string, ParamSpec>;
  /** REST endpoint. May contain :param placeholders (e.g. /v1/tickets/:key/close). */
  endpoint: string;
  method: "GET" | "POST";
  /** Write tools run with CMMS_API_TOKEN_WRITE and require an explicit user request. */
  write?: boolean;
  /** Rewrite the tool args into the REST body (default: pass args through). */
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
};

const languageProps: { d: string; e: string[] } = {
  d: "hu | en — response/description language",
  e: ["hu", "en"],
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: "answer_question",
    description: [
      "EN: PRIMARY TOOL for any free-text question. Pass the user's question as `q` (hu or en). A deterministic router extracts sorszam/device/customer/period and returns a ready-to-cite `summary` plus evidence. Same question in → same plan out. Call this FIRST; only reach for other tools when its result is insufficient.",
      "HU: ELSŐDLEGES ESZKÖZ bármilyen szabad szöveges kérdésre. Add át a kérdést `q`-ként. A router kinyeri a sorszámot/gépet/ügyfelet/időszakot és idézhető összegzést ad. Ezt hívd ELŐSZÖR.",
    ].join(" "),
    // Deliberately q-only (+ language/limit): the router extracts
    // sorszam/device/customer/period/status from the question itself.
    // Optional override params here invite the LLM to INVENT filters
    // (observed: status:"open" added to "M26057 vezérlés" → false
    // negative "nincs információ"). Explicit filters belong on
    // search_tickets, where the user actually asked for them.
    props: {
      q: { t: "string", d: "The user's question, verbatim (Hungarian or English). Required.", r: true },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max results (default 20)" },
    },
    endpoint: "/v1/answer",
    method: "POST",
  },
  {
    name: "search_tickets",
    description: [
      "EN: Unified search across CMMS tickets. Auto-extracts customer/device/sorszam/period from `q`, then applies explicit filters. Use when answer_question returned nothing useful or you need raw rows.",
      "HU: Egységes keresés a jegyek között. A `q`-ból kinyeri az ügyfelet/gépet/sorszámot/időszakot, majd alkalmazza a szűrőket.",
    ].join(" "),
    props: {
      q: { t: "string", d: "Free-text query with auto-extracted filters" },
      customer: { t: "string", d: "Explicit customer filter" },
      device: { t: "string", d: "Explicit device filter" },
      sorszam: { t: "string", d: "Explicit sorszam filter" },
      status: { t: "string", d: "Filter by job status", e: ["open", "closed"] },
      kategoria: { t: "string", d: "Substring match on issue category" },
      kategoria_inferred: { t: "string", d: "Substring match on inferred category" },
      sulyossag_inferred: { t: "string", d: "Filter by inferred severity", e: ["alacsony", "kozepes", "magas", "kritikus"] },
      date_from: { t: "string", d: "YYYY-MM-DD lower bound (only if the question mentions a date)" },
      date_to: { t: "string", d: "YYYY-MM-DD upper bound (only if the question mentions a date)" },
      period: { t: "string", d: "Period preset (this_year, tavaly, utolsó 30 nap, ...)" },
      include_evidence: { t: "boolean", d: "Include sample sorszam+snippet evidence (default true)" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max results (default 20)" },
    },
    endpoint: "/v1/jobs/search",
    method: "POST",
  },
  {
    name: "get_ticket_stats",
    description: [
      "EN: ALWAYS USE for counting/ranking/aggregation: 'which customer has most tickets?', 'open vs closed', 'most common fault category', 'which machine type breaks most?'. Returns pre-counted groups, each with 1-2 sample tickets as evidence.",
      "HU: MINDIG EZT HASZNÁLD számoláshoz, rangsoroláshoz, aggregációhoz ('melyik ügyfélhez járunk a legtöbbet?', 'hány nyitott/leárt?', 'leggyakoribb hibakategória?').",
    ].join(" "),
    props: {
      group_by: {
        t: "string",
        d: "Dimension to aggregate by — REQUIRED",
        e: ["customer", "device", "technician", "status", "month", "kategoria", "sulyossag", "machine_type", "controller"],
        r: true,
      },
      q: { t: "string", d: "Free text filter (AND-of-tokens)" },
      customer: { t: "string", d: "Substring filter on customer" },
      device: { t: "string", d: "Substring filter on device" },
      status: { t: "string", d: "Filter by status", e: ["open", "closed"] },
      period: { t: "string", d: "Period preset (this_year, tavaly, utolsó 30 nap, ...)" },
      kategoria: { t: "string", d: "Substring filter on category" },
      sulyossag: { t: "string", d: "Filter on severity", e: ["alacsony", "kozepes", "magas", "kritikus"] },
      controller: { t: "string", d: "Substring filter on controller" },
      include_evidence: { t: "boolean", d: "Attach 1-2 sample tickets per group (default true)" },
      evidence_per_group: { t: "integer", d: "Max samples per group (default 2, max 5)" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max results (default 50, max 500)" },
    },
    endpoint: "/v1/jobs/stats",
    method: "POST",
  },
  {
    name: "find_recurring_problems",
    description: [
      "EN: Find clusters of 2+ tickets sharing a root-cause signature. USE for 'what problem kept coming back?', 'was this issue fixed before?'. NOT for raw counts (use get_ticket_stats).",
      "HU: Visszatérő hibacsoportok keresése ('mi jött vissza újra?', 'volt már ilyen hiba?'). Nyers számoláshoz get_ticket_stats.",
    ].join(" "),
    props: {
      customer: { t: "string", d: "Filter to a specific customer" },
      machine: { t: "string", d: "Filter to a machine type (pl. 'TMV-400')" },
      controller: { t: "string", d: "Filter to a controller (pl. 'NCT104')" },
      kategoria: { t: "string", d: "Filter to a problem category" },
      period: { t: "string", d: "Period preset" },
      scope: { t: "string", d: "Signature strictness (default broad)", e: ["narrow", "broad", "broadest"] },
      min_visits: { t: "integer", d: "Minimum visits per cluster (default 2)" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max clusters (default 20)" },
    },
    endpoint: "/v1/jobs/recurring-problems",
    method: "POST",
  },
  {
    name: "get_problem_cluster",
    description: [
      "EN: Full ordered ticket list of one recurring-problem cluster: visit_count, technicians, first_seen/last_seen, handoffs (tech A tried, tech B fixed).",
      "HU: Egy konkrét visszatérő hibacsoport összes jegye: látogatások, technikusok, dátumok, technikus-váltások.",
    ].join(" "),
    props: {
      customer: { t: "string", d: "Customer name (narrow scope)" },
      machine: { t: "string", d: "Machine type" },
      controller: { t: "string", d: "Controller" },
      kategoria: { t: "string", d: "Problem category" },
      period: { t: "string", d: "Period preset" },
      scope: { t: "string", d: "Signature strictness (default broad)", e: ["narrow", "broad", "broadest"] },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max tickets (default 50)" },
    },
    endpoint: "/v1/jobs/recurring-problems/cluster",
    method: "POST",
  },
  {
    name: "find_related_tickets",
    description: [
      "EN: Cross-database timeline for a seed sorszam or customer+device, across main CMMS, serviz_belso, szev_igeny and telephely_munka. USE: 'mi volt még akkor?', 'show everything related to this case'.",
      "HU: Kereszttáblás időrend egy sorszámhoz vagy ügyfél+géphez, minden forrásból ('kapcsolódó bejegyzések').",
    ].join(" "),
    props: {
      sorszam: { t: "string", d: "Seed sorszam (e.g. 'B-2024/0891')" },
      customer: { t: "string", d: "Seed customer (substring)" },
      device: { t: "string", d: "Seed device (e.g. 'TMV-400')" },
      window_days: { t: "integer", d: "Date proximity window in days (default 180)" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max entries (default 50)" },
    },
    endpoint: "/v1/related",
    method: "POST",
  },
  {
    name: "find_linkage",
    description: [
      "EN: Sorszam cross-reference graph built from note bodies. top_hubs: 'which work order had the most references?'; referenced_by: 'what references this ticket?'; references: 'what does this ticket reference?'; stats: global total.",
      "HU: Jegy-hivatkozási gráf. top_hubs: 'melyik munkához történt a legtöbb kiszállás?'; referenced_by: 'mi hivatkozik erre?'; references: 'ez mire hivatkozik?'.",
    ].join(" "),
    props: {
      direction: {
        t: "string",
        d: "What to look up — REQUIRED",
        e: ["stats", "top_hubs", "referenced_by", "references"],
        r: true,
      },
      sorszam: { t: "string", d: "Sorszam to look up (required for referenced_by / references)" },
      limit: { t: "integer", d: "Max results (default 10)" },
    },
    endpoint: "/v1/jobs/linkage",
    method: "GET",
  },
  {
    name: "get_failure_rates",
    description: [
      "EN: Per-model failure rates from the statisztika table. USE: 'which machine type is most unreliable?', 'TMV failure rate'.",
      "HU: Géptípus meghibásodási arányok ('melyik gép romlik el a legtöbbször?').",
    ].join(" "),
    props: {
      period: { t: "string", d: "Period preset" },
      model_filter: { t: "string", d: "Substring match on model name (e.g. 'TMV', 'DPB')" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max rows (default 50)" },
    },
    endpoint: "/v1/integration/failure-rates",
    method: "POST",
  },
  {
    name: "find_spare_motor",
    description: [
      "EN: Find a replacement motor in the bad-AiS stock for a machine + motor type. Returns candidates with match_score 0..1. USE: 'van pótmotorunk M16119-ről?'.",
      "HU: Csere motor keresése a selejt AiS raktárban ('van tartalék motorunk?'), match_score 0..1.",
    ].join(" "),
    props: {
      serial_number: { t: "string", d: "Machine serial number (e.g. 'M10170')" },
      motor_type: { t: "string", d: "Motor type (e.g. 'AiS100')" },
      problem: { t: "string", d: "Free-text problem description" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max candidates (default 5)" },
    },
    endpoint: "/v1/integration/spare-motor",
    method: "POST",
  },
  {
    name: "search_customers",
    description: [
      "EN: Substring search for customer names with per-customer ticket counts. USE to disambiguate a customer name before searching their tickets.",
      "HU: Ügyfélnevek részleges keresése, jegy-számlálóval. Használd az ügyfélnév egyértelműsítéséhez.",
    ].join(" "),
    props: {
      q: { t: "string", d: "Substring to search for in customer name — REQUIRED", r: true },
      min_tickets: { t: "integer", d: "Minimum ticket count (default 0)" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max customers (default 20)" },
    },
    endpoint: "/v1/customers/search",
    method: "GET",
  },
  {
    name: "customer_canonical",
    description: [
      "EN: Group spelling variants of the same real customer ('ANDRITZ KFT.' vs 'ANDRITZ Magyarország Kft.'). Returns the canonical group + variants with ticket counts.",
      "HU: Azonos ügyfél írásváltozatainak csoportosítása, kanonikus névvel és jegy-számokkal.",
    ].join(" "),
    props: {
      q: { t: "string", d: "Substring to canonicalize (e.g. 'ANDRITZ') — REQUIRED", r: true },
      min_tickets: { t: "integer", d: "Minimum ticket count to include (default 1)" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max variants (default 10)" },
    },
    endpoint: "/v1/customers/canonical",
    method: "POST",
  },
  {
    name: "search_serviz_belso",
    description: [
      "EN: Search the internal workshop service-ticket archive (2008-now). Separate from the main CMMS. USE: 'did we see this fault internally?', '2018 TMV-400 internal tickets'.",
      "HU: Belső szerviz archívum (2008-tól). 'Volt már ilyen belső hibánk?'",
    ].join(" "),
    props: {
      q: { t: "string", d: "Free text (FTS5)" },
      j_szam: { t: "string", d: "Substring match on J-sorszam (pl. 'J00001')" },
      cegnev: { t: "string", d: "Substring match on customer" },
      eszkoz: { t: "string", d: "Substring match on device type" },
      dolgozo: { t: "string", d: "Substring match on technician" },
      date_from: { t: "string", d: "YYYY-MM-DD lower bound (only if the question mentions a date)" },
      date_to: { t: "string", d: "YYYY-MM-DD upper bound (only if the question mentions a date)" },
      source_period: { t: "string", d: "Source file tag (pl. '2008-2020')" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max results (default 50)" },
      offset: { t: "integer", d: "Pagination offset" },
    },
    endpoint: "/v1/integration/serviz/search",
    method: "GET",
  },
  {
    name: "get_serviz_ticket",
    description: [
      "EN: Fetch a single internal service ticket by J-sorszam (e.g. 'J00001').",
      "HU: Egy belső szerviz jegy lekérése J-sorszám alapján.",
    ].join(" "),
    props: {
      j: { t: "string", d: "J-sorszam, pl. 'J00001' — REQUIRED", r: true },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/integration/serviz/by-j-szam",
    method: "GET",
  },
  {
    name: "search_szev_igeny",
    description: [
      "EN: Search the internal procurement / service requisition log (2019-now): bearings, parts, external services. USE: 'what bearings did we order for X in 2024?'.",
      "HU: Belső anyagrendelés / szerviz igénylések (2019-től): csapágyak, alkatrészek, külső szolgáltatások.",
    ].join(" "),
    props: {
      q: { t: "string", d: "Free text (FTS5)" },
      megrendelo: { t: "string", d: "Substring match on customer" },
      geptipus: { t: "string", d: "Substring match on machine type" },
      munkaszam: { t: "string", d: "Substring match on munkaszam" },
      felelos: { t: "string", d: "Substring match on responsible person" },
      year: { t: "integer", d: "Filter by year (2019-2026)" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max results" },
      offset: { t: "integer", d: "Pagination offset" },
    },
    endpoint: "/v1/integration/szev/search",
    method: "GET",
  },
  {
    name: "search_telephely_munka",
    description: [
      "EN: Search the in-house workshop job log: parts brought back to the depot for repair/rebuild, on-site (TH) repairs. USE: 'did we ever rebuild this build element?', 'all telephely jobs for M14066'.",
      "HU: Telephelyi munkák: visszahozott alkatrészek felújítása, helyszíni (TH) javítások.",
    ].join(" "),
    props: {
      q: { t: "string", d: "Free text (FTS5)" },
      megrendelo: { t: "string", d: "Substring match on customer" },
      geptipus: { t: "string", d: "Substring match on machine type" },
      munkaszam: { t: "string", d: "Substring match on munkaszam" },
      year: { t: "integer", d: "Filter by year" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max results" },
      offset: { t: "integer", d: "Pagination offset" },
    },
    endpoint: "/v1/integration/telephely/search",
    method: "GET",
  },
  {
    name: "search_ais_motor_inventory",
    description: [
      "EN: List the bad-AiS motor stock (50+ motors) with original machine, failure mode, remaining parts. USE: 'do we have a spare AiS100 from M16119?', 'which zárlatos motors are in stock?'.",
      "HU: Selejt AiS motor raktár: eredeti gép, hibaok, maradék alkatrész. 'Van pótmotorunk?'",
    ].join(" "),
    props: {
      q: { t: "string", d: "Free text (FTS5)" },
      tipus: { t: "string", d: "Exact match on motor type (pl. 'AiS100')" },
      gep: { t: "string", d: "Substring match on original machine ID" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
      limit: { t: "integer", d: "Max results (default 50)" },
      offset: { t: "integer", d: "Pagination offset" },
    },
    endpoint: "/v1/integration/ais/search",
    method: "GET",
  },
  {
    name: "get_integration_stats",
    description: [
      "EN: Aggregate counts across the integrated CMMS data: SZÉV by year, serviz by source period, top motor types in the bad-AiS inventory.",
      "HU: Integrált CMMS adat aggregátumok: SZÉV évek, szerviz források, top motor típusok.",
    ].join(" "),
    props: {
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/integration/stats",
    method: "GET",
  },
  {
    name: "get_categories",
    description: [
      "EN: List all available issue categories. Use before assigning a category to a ticket.",
      "HU: Elérhető hibakategóriák listája. Használd mielőtt kategóriát rendelsz.",
    ].join(" "),
    props: {
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/categories",
    method: "GET",
  },
  {
    name: "get_tags",
    description: [
      "EN: List all tags that can be attached to tickets.",
      "HU: Elérhető címkék listája, amiket jegyekhez lehet rendelni.",
    ].join(" "),
    props: {
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/tags",
    method: "GET",
  },

  // -----------------------------------------------------------------------
  // WRITE tools — only on explicit user request (system prompt enforces).
  // -----------------------------------------------------------------------

  {
    name: "create_ticket",
    description: [
      "EN: WRITE — create a maintenance ticket. Only customer_name is required; fill the rest from the conversation. Call ONLY when the user explicitly asks to log a new ticket.",
      "HU: ÍRÁS — új szerviz jegy létrehozása. Csak customer_name kötelező. CSAK akkor hívd, ha a felhasználó kifejezetten kéri.",
    ].join(" "),
    props: {
      customer_name: { t: "string", d: "Customer or site name — REQUIRED", r: true },
      customer_zip: { t: "string", d: "Postal code" },
      customer_address: { t: "string", d: "Address" },
      customer_phone: { t: "string", d: "Phone number" },
      customer_email: { t: "string", d: "Email address" },
      devices: { t: "string-array", d: "Device identifiers (pl. 'NCT2000', 'TMV-400(10297;M10170)')" },
      reported: { t: "string", d: "Problem description (BEJELENTETT HIBA)" },
      work: { t: "string", d: "Completed work (ELVÉGZETT MUNKA)" },
      technician: { t: "string", d: "Assigned technician" },
      reporter: { t: "string", d: "Who reported the fault" },
      fault_receiver: { t: "string", d: "Who received the report" },
      payment: { t: "string", d: "Payment status", e: ["fiz", "gar"] },
      remote_access: { t: "string", d: "Remote access info" },
      status: { t: "string", d: "Initial status (default open)", e: ["open", "closed"] },
      problem_kategoria: { t: "string", d: "Issue category (pl. 'Szoftver hiba', 'Hardver hiba', 'Vezérlő hiba')" },
      problem_alkategoria: { t: "string", d: "Subcategory" },
      sulyossag: { t: "string", d: "Severity", e: ["alacsony", "kozepes", "magas", "kritikus"] },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/tickets/create",
    method: "POST",
    write: true,
  },
  {
    name: "modify_ticket",
    description: [
      "EN: WRITE — update one or more fields on an existing ticket by sorszam. Omitted fields stay as-is. Call ONLY on explicit user request.",
      "HU: ÍRÁS — meglévő jegy mezőinek módosítása sorszám alapján. Csak kifejezett kérésre.",
    ].join(" "),
    props: {
      sorszam: { t: "string", d: "Ticket sorszam (pl. B26072216) — REQUIRED", r: true },
      customer_name: { t: "string", d: "Corrected customer name" },
      customer_zip: { t: "string", d: "Corrected postal code" },
      customer_address: { t: "string", d: "Corrected address" },
      customer_phone: { t: "string", d: "Corrected phone" },
      customer_email: { t: "string", d: "Corrected email" },
      devices: { t: "string-array", d: "Corrected device list (replaces)" },
      reported: { t: "string", d: "Append a note to the problem description" },
      work: { t: "string", d: "Append a note to completed work" },
      technician: { t: "string", d: "Corrected technician" },
      reporter: { t: "string", d: "Corrected reporter" },
      fault_receiver: { t: "string", d: "Corrected fault receiver" },
      payment: { t: "string", d: "Corrected payment status", e: ["fiz", "gar"] },
      remote_access: { t: "string", d: "Corrected remote access" },
      status: { t: "string", d: "Corrected status", e: ["open", "closed"] },
      problem_kategoria: { t: "string", d: "Corrected issue category" },
      problem_alkategoria: { t: "string", d: "Corrected subcategory" },
      sulyossag: { t: "string", d: "Corrected severity", e: ["alacsony", "kozepes", "magas", "kritikus"] },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/tickets/modify",
    method: "POST",
    write: true,
  },
  {
    name: "close_ticket",
    description: [
      "EN: WRITE — close a ticket by its integer `key` (from search results). Optional solution text goes into the ELVÉGZETT MUNKA field. Call ONLY on explicit user request.",
      "HU: ÍRÁS — jegy lezárása egész kulccsal; a megoldás szövege a munka mezőbe kerül. Csak kifejezett kérésre.",
    ].join(" "),
    props: {
      key: { t: "integer", d: "Integer job KEY to close — REQUIRED", r: true },
      text: { t: "string", d: "Solution description (what was done)" },
      author: { t: "string", d: "Who performed the fix" },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/tickets/:key/close",
    method: "POST",
    write: true,
    body: (args) => {
      const b: Record<string, unknown> = {};
      if (typeof args.text === "string" && args.text.trim()) b.text = args.text;
      if (typeof args.author === "string" && args.author.trim()) b.author = args.author;
      return b;
    },
  },
  {
    name: "add_ticket_tag",
    description: [
      "EN: WRITE — add a tag to a ticket by integer key. The tag is created if it doesn't exist. Call ONLY on explicit user request.",
      "HU: ÍRÁS — címke hozzáadása egy jegyhez; ha nem létezik, létrejön. Csak kifejezett kérésre.",
    ].join(" "),
    props: {
      key: { t: "integer", d: "Integer job KEY — REQUIRED", r: true },
      nev: { t: "string", d: "Tag name (created if new) — REQUIRED", r: true },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/tickets/:key/tags",
    method: "POST",
    write: true,
    body: (args) => ({ nev: String(args.nev ?? "") }),
  },
  {
    name: "set_ticket_category",
    description: [
      "EN: WRITE — set the primary issue category on a ticket by sorszam. Call ONLY on explicit user request.",
      "HU: ÍRÁS — elsődleges kategória beállítása sorszám alapján. Csak kifejezett kérésre.",
    ].join(" "),
    props: {
      sorszam: { t: "string", d: "Ticket sorszam (pl. B26072216) — REQUIRED", r: true },
      problem_kategoria: { t: "string", d: "Category name (pl. 'Szoftver hiba') — REQUIRED", r: true },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/tickets/modify",
    method: "POST",
    write: true,
    body: (args) => ({ sorszam: String(args.sorszam ?? ""), problem_kategoria: String(args.problem_kategoria ?? "") }),
  },
  {
    name: "set_ticket_severity",
    description: [
      "EN: WRITE — set the severity on a ticket by sorszam. Call ONLY on explicit user request.",
      "HU: ÍRÁS — súlyosság beállítása sorszám alapján. Csak kifejezett kérésre.",
    ].join(" "),
    props: {
      sorszam: { t: "string", d: "Ticket sorszam — REQUIRED", r: true },
      sulyossag: { t: "string", d: "Severity — REQUIRED", e: ["alacsony", "kozepes", "magas", "kritikus"], r: true },
      language: { t: "string", d: languageProps.d, e: languageProps.e },
    },
    endpoint: "/v1/tickets/modify",
    method: "POST",
    write: true,
    body: (args) => ({ sorszam: String(args.sorszam ?? ""), sulyossag: String(args.sulyossag ?? "") }),
  },
];

// ---------------------------------------------------------------------------
// OpenAI tools payload (the `tools` array of chat/completions)
// ---------------------------------------------------------------------------

export const AGENT_TOOLS_OPENAI = AGENT_TOOLS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: { type: "object", ...schema(t.props) },
  },
}));

// ---------------------------------------------------------------------------
// Executor — self-fetch to the cmms-api REST surface, same contract as
// mcp-server.ts's call()/guardedCall(): bearer token, JSON body for POST,
// query-string serialization for GET (arrays repeated, objects stringified).
// ---------------------------------------------------------------------------

export type AgentToolContext = {
  baseUrl: string;
  readToken: string;
  writeToken: string;
  /** Per tool-call timeout, default 10s (mirrors mcp-server call()). */
  timeoutMs?: number;
};

export type AgentToolResult = {
  ok: boolean;
  /** JSON string of the REST payload, or an error text. */
  text: string;
  /** Short human note for the trace chip (e.g. missing write token). */
  note?: string;
};

const SKIP_QUERY = new Set(["language", "_raw"]);

function toQueryString(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null) continue;
        params.append(k, typeof item === "string" ? item : JSON.stringify(item));
      }
    } else if (typeof v === "object") {
      params.append(k, JSON.stringify(v));
    } else {
      params.append(k, String(v));
    }
  }
  return params.toString();
}

export async function callAgentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<AgentToolResult> {
  const def = AGENT_TOOLS.find((t) => t.name === name);
  if (!def) {
    return { ok: false, text: `Unknown tool: "${name}". Pick from the available tools only.` };
  }
  if (def.write && !ctx.writeToken) {
    return { ok: false, note: "no write token", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." };
  }

  const token = def.write ? ctx.writeToken : ctx.readToken;
  if (!token) {
    return { ok: false, note: "no read token", text: "Read token (CMMS_API_TOKEN_READ) is not configured." };
  }

  // Path placeholders (:key etc.) come from the args.
  let path = def.endpoint;
  path = path.replace(/:([A-Za-z_]+)/g, (_m, keyName: string) => {
    const v = args[keyName];
    return v === undefined || v === null ? "" : encodeURIComponent(String(v));
  });

  const body = def.body ? def.body(args) : args;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 10_000);
  try {
    const url =
      def.method === "GET"
        ? (() => {
            const qs = toQueryString(body);
            return qs ? `${ctx.baseUrl}${path}${path.includes("?") ? "&" : "?"}${qs}` : `${ctx.baseUrl}${path}`;
          })()
        : `${ctx.baseUrl}${path}`;
    const res = await fetch(url, {
      method: def.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(def.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body: def.method === "POST" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, text: `${res.status} ${res.statusText}: ${text}` };
    }
    return { ok: true, text: text || "{}" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return {
      ok: false,
      text: `Tool call failed: ${msg}${msg.includes("abort") ? " (timeout)" : ""}`,
      note: "timeout/network",
    };
  } finally {
    clearTimeout(timer);
  }
}
