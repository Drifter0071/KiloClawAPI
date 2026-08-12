// Server-side question router (Phase 1, R2 in docs/cmms-mcp-redesign.md).
//
// What this is
// ------------
// A pure, deterministic, keyword-based classifier that turns a free-text
// question (in Hungarian or English) into a `RoutePlan` — a small
// object describing which primitive(s) to call and which fields to
// extract. The plan is then executed by the route handler against the
// JobCache; the LLM mostly just relays the answer.
//
// Why a server-side router?
// -------------------------
// Before Phase 1, the LLM had to pick from 18 tools by prose and
// produced inconsistent answers (65% reproducibility across sessions).
// Moving the decision to the server collapses that variance: same
// question in -> same plan out, every time, regardless of the model.
//
// Why keyword/decision-tree and not LLM?
// --------------------------------------
// Same reason: deterministic + reproducible + free. Adding an LLM
// call here would just re-introduce the variance we are trying to
// remove. The 100-question catalog in docs/cmms-mcp-redesign.md is
// small enough to map by hand. If we need to expand the catalog, the
// pattern is "add a rule, run tests" — not "re-evaluate the prompt".

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouteIntent =
  | "top_customers"
  | "top_customers_in_period"
  | "top_customer_open_tickets"
  | "top_customer_critical_tickets"
  | "top_devices"
  | "top_machine_type"
  | "top_controllers"
  | "top_kategoriak"
  | "top_kategoriak_inferred"
  | "top_sulyossag"
  | "top_technicians"
  | "top_technicians_open"
  | "count_by_status"
  | "count_by_month"
  | "customer_open_count"
  | "customer_last_seen"
  | "customer_top_devices"
  | "customer_top_kategoriak"
  | "customer_top_technicians"
  | "customer_tickets_list"
  | "device_tickets_list"
  | "device_top_problem"
  | "device_total_count"
  | "device_top_customers"
  | "critical_open_now"
  | "open_count_now"
  | "open_count_by_kategoria"
  | "open_count_by_machine"
  | "top_hubs"
  | "find_ticket_by_sorszam"
  | "find_pattern"
  | "find_related"
  | "search_internal"
  | "search_szev"
  | "search_telephely"
  | "find_spare_motor"
  | "failure_rates"
  | "get_categories"
  | "get_tags"
  | "search_tickets"
  | "needs_clarification";

export type RoutePrimitive =
  | "search_tickets"
  | "stats"
  | "find_ticket_by_sorszam"
  | "find_recurring_problems"
  | "find_related_tickets"
  | "top_hubs"
  | "search_serviz_archive"
  | "search_szev_igeny"
  | "search_telephely_munka"
  | "find_spare_motor"
  | "get_failure_rates"
  | "get_categories"
  | "get_tags"
  | "search_ais_motor_inventory";

export type RouteFilter = {
  customer?: string;
  device?: string;
  controller?: string;
  machine_type?: string;
  kategoria?: string;
  kategoria_inferred?: string;
  sulyossag_inferred?: string;
  status?: "open" | "closed";
  sorszam?: string;
  q?: string;
};

export type RoutePlan = {
  intent: RouteIntent;
  primitive: RoutePrimitive;
  group_by?:
    | "customer"
    | "device"
    | "machine_type"
    | "controller"
    | "kategoria"
    | "kategoria_inferred"
    | "sulyossag_inferred"
    | "technician"
    | "status"
    | "month";
  filters: RouteFilter;
  period?: string; // server-resolves this
  limit?: number;
  order?: "count_desc" | "recent_desc";
  follow_ups: string[]; // suggested next questions in user's language
  rationale: string; // short hu/en explanation, surfaced in logs
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HU_NUMBER_WORDS: Record<string, number> = {
  egy: 1, ketto: 2, kettő: 2, harom: 3, három: 3, negy: 4, négy: 4,
  ot: 5, öt: 5, hat: 6, het: 7, hét: 7, nyolc: 8, kilenc: 9, tiz: 10, tíz: 10,
};

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[?!.,;:]/g, " ");
}

function has(text: string, ...needles: string[]): boolean {
  const t = norm(text);
  for (const n of needles) {
    const nn = norm(n);
    // For very short tokens (≤ 2 chars) do a whole-word check so
    // "ma" doesn't match inside "Melyik" or "most". For tokens
    // of 3+ chars plain substring is fine — "gep" still matches
    // "gepeket", "kritikus" still matches "kritikus" or
    // "kritikusok", etc. This is the Phase 3 fix.
    if (nn.length <= 2) {
      const escaped = nn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`);
      if (re.test(t)) return true;
    } else if (t.includes(nn)) {
      return true;
    }
  }
  return false;
}

function detectPeriod(text: string): string | undefined {
  if (has(text, "today", "ma", "mai nap")) return "today";
  if (has(text, "yesterday", "tegnap", "tegnapi")) return "yesterday";
  if (has(text, "this month", "this_month", "ebben a honapban", "ebben a hónapban", "az aktualis honapban", "az aktuális hónapban")) return "this_month";
  if (has(text, "last month", "last_month", "mult honapban", "múlt hónapban", "elozo honapban", "előző hónapban")) return "last_month";
  if (has(text, "this year", "this_year", "iden", "idén", "ez evben", "ez évben", "ebben az evben", "ebben az évben", "az aktualis evben", "az aktuális évben")) return "this_year";
  if (has(text, "last year", "last_year", "tavaly", "az elozo evben", "az előző évben")) return "last_year";
  if (has(text, "last week", "last_week", "múlt hét", "mult het", "elozo het", "előző hét")) return "last_week";
  if (has(text, "last 7 days", "last_7_days", "utolso 7 nap", "utolsó 7 nap", "múlt 7 nap")) return "last_7_days";
  if (has(text, "last 30 days", "last_30_days", "utolso 30 nap", "utolsó 30 nap", "múlt 30 nap")) return "last_30_days";
  if (has(text, "last 90 days", "last_90_days", "utolso 90 nap", "utolsó 90 nap")) return "last_90_days";
  if (has(text, "ytd", "year to date", "ev elejetol", "év elejétől")) return "YTD";
  if (has(text, "this quarter", "this_quarter", "ebben a negyedevben", "ebben a negyedévben")) return "this_quarter";
  if (has(text, "last quarter", "last_quarter", "múlt negyedév", "mult negyedev")) return "last_quarter";
  if (has(text, "all time", "osszesen", "mind", "minden", "eddig", "teljes", "minden eddigi")) return "all";
  return undefined;
}

function extractCustomer(text: string): string | undefined {
  // Use a non-greedy match bounded by the legal suffix. Each internal
  // token in the captured group must be Capitalized; this stops the
  // regex from greedily absorbing leading question words like "Mikor
  // volt ... ANDRITZ Kft.".
  const cap = "[A-ZÁÉÍÓÖŐÚÜŰ][A-ZÁÉÍÓÖŐÚÜŰa-záéíóöőúüű0-9\\.\\-]*";
  const sep = "(?:\\s|\\s*&\\s*|\\s*\\-\\s*)";
  const capWord = `(?:${cap}${sep})*${cap}`;
  const patterns: RegExp[] = [
    // "[CapWords] (Kft.|Bt.|Zrt.|Rt.|Nyrt.|Kkt.)"
    new RegExp(`(${capWord})\\s+(?:Kft|Bt|Zrt|Rt|Nyrt|Kkt)\\.?\\b`),
    // "[CapWords] -nál / -nél / nál / nel"
    new RegExp(`(${capWord})\\s*[\\-]?(?:nál|nél|nal|nel)\\b`),
    // English: "for [CapWord...]" or "at [CapWord...]"
    /\b(?:for|at)\s+([A-Z][A-Za-z\.\-]{2,40})/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) {
      const out = m[1].trim();
      if (out.length >= 3) return out;
    }
  }
  return undefined;
}

function extractDevice(text: string): string | undefined {
  // Each pattern must have a capture group so m[1] is defined; the
  // M-serial pattern (9) used to be `\bM\d{4,6}\b` (no group) and
  // silently never matched — see Phase 3 regression test #13.
  const patterns: RegExp[] = [
    /\b(nct[\s\-]?\d{2,4})\b/i,
    /\b(tmv[\s\-]?\d{2,4})\b/i,
    /\b(dpx?[\s\-]?\d{1,3}(?:[\-\s]\d{1,3})?)\b/i,
    /\b(d[abns][\s\-]?\d{2,4})\b/i,
    /\b(few[\s\-]?\d{0,3})\b/i,
    /\b(ips[\s\-]?\d{0,3}|ihdw[\s\-]?\d{0,3})\b/i,
    /\b(kafo[\s\-]?\d{0,3}|eml[\s\-]?\d{0,3}|emr[\s\-]?\d{0,3})\b/i,
    /\b(veu[\s\-]?\d{0,3}|vd[\s\-]?\d{0,3}|bnc[\s\-]?\d{0,3})\b/i,
    /\b(M\d{4,6})\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) return m[1].toUpperCase().replace(/\s+/g, "-");
  }
  return undefined;
}

function extractSorszam(text: string): string | undefined {
  const m = text.match(/\bB\d{7,9}\b/i);
  return m ? m[0].toUpperCase() : undefined;
}

// Compute the leftover prose after stripping identifiers (device, sorszam,
// customer) that the router already captured. Used to thread `q` through
// the device/customer branches so questions like "X tengely golyós orsó
// csapágyak típusa, M09192 munkánál" don't lose their actual question.
//
// The result is the original text with the captured identifiers removed
// and whitespace collapsed. Empty / very short leftovers are rejected by
// the caller (e.g. "M09192" alone -> ""), so bare device questions still
// hit `device_tickets_list` without forcing an AND on every token of an
// essentially-empty q.
function leftoverProse(
  text: string,
  ids: { device?: string; sorszam?: string; customer?: string },
): string {
  let s = text;
  if (ids.device) {
    // strip the device token (hyphens normalized away on extraction)
    const d = ids.device.replace(/[-\s]/g, "");
    s = s.replace(new RegExp(`\\b${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), " ");
  }
  if (ids.sorszam) {
    s = s.replace(new RegExp(`\\b${ids.sorszam}\\b`, "i"), " ");
  }
  if (ids.customer) {
    // customer may have a Kft./Bt. suffix that we captured; only the
    // first word is reliably safe to strip (to avoid over-deleting).
    const first = ids.customer.split(/\s+/)[0];
    if (first && first.length >= 4) {
      s = s.replace(new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), " ");
    }
  }
  // collapse punctuation + whitespace
  s = s.replace(/[?!.,;:]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

function extractTopN(text: string): number | undefined {
  const m = text.match(/\b(?:top|legjobb|legrosszabb|legtobb|legkevesebb|legnagyobb|legkisebb)\s+(\d+)\b/i);
  if (m && m[1]) return Number(m[1]);
  const words = text.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (/^(top|legjobb|legrosszabb|legtobb|legkevesebb|legnagyobb|legkisebb)$/i.test(words[i])) {
      const next = words[i + 1];
      if (next && HU_NUMBER_WORDS[next] !== undefined) return HU_NUMBER_WORDS[next];
    }
  }
  return undefined;
}

// Localized follow-ups. We translate a few key intents to English so
// the answer is useful regardless of input language. Untranslated
// intents get a generic English follow-up.
const EN_FOLLOWUP_BY_INTENT: Partial<Record<RouteIntent, string[]>> = {
  top_customers: ["Which customer has the most open tickets?", "What machines do we service for the top customers?"],
  top_machine_type: ["Which controller causes the most failures?", "What's the most common failure category?"],
  top_controllers: ["Show me the NCT104 software issues", "Which machine breaks the most?"],
  top_kategoriak_inferred: ["Show me the software failures", "Which category is growing?"],
  top_sulyossag: ["Show me the critical tickets", "Which customer has the most critical tickets?"],
  top_technicians: ["Which technician closed the most tickets?", "Which technician has the most open tickets?"],
  top_technicians_open: ["Which technician is best at which controller?"],
  count_by_status: ["Show me the open tickets", "How many critical are open now?"],
  count_by_month: ["What are the 3 worst months?", "What's the crisis trend?"],
  critical_open_now: ["Show me the critical tickets", "Which customer has the most open tickets?"],
  search_tickets: ["Show me the top 5 hits", "Only the critical tickets please"],
  find_related: ["Show me the full timeline", "Are there any open tickets for this machine?"],
  needs_clarification: ["Which customer do we visit most?", "Show me the TMV-400 tickets", "How many critical tickets are open now?"],
};

function fu(language: "hu" | "en", intent: RouteIntent, hu: string[]): string[] {
  if (language === "hu") return hu;
  return EN_FOLLOWUP_BY_INTENT[intent] ?? hu.map((h) => h); // best-effort fallback
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function routeQuestion(q: string, language: "hu" | "en" = "hu"): RoutePlan {
  const text = (q ?? "").trim();
  const n = norm(text);
  const period = detectPeriod(text);
  const customer = extractCustomer(text);
  const device = extractDevice(text);
  const sorszam = extractSorszam(text);
  const topN = extractTopN(text);

  const f: RouteFilter = {};
  if (customer) f.customer = customer;
  if (device) f.device = device;
  if (sorszam) f.sorszam = sorszam;

  // ---- Sorszam + related keywords → find_related (must come before
  // plain sorszam lookup so "B123456 folytatása" routes correctly) ----
  if (sorszam && has(text, "folytatas", "folytatás", "elozmeny", "előzmény", "összefüggés", "osszefugg", "kapcsolodo", "kapcsolód", "utana", "utána", "elotte", "előtte", "kovetkez", "következ", "tortenet", "történet", "minden rola", "minden róla", "related", "follow-up", "followup", "continuation", "history", "preceding")) {
    return {
      intent: "find_related",
      primitive: "find_related_tickets",
      filters: f,
      period,
      follow_ups: fu(language, "find_related", [
        "Mutasd a teljes történetet",
        "Van-e nyitott ticket még ugyanerre a gépre?",
      ]),
      rationale: "sorszam + related keywords → find_related",
    };
  }

  // ---- Single-ticket lookup ----
  if (sorszam) {
    // Thread leftover prose (minus the sorszam itself) so attribute
    // questions like "Milyen vezérlés van a B26071801 munkán?" keep
    // the "milyen vezérlés" part for the summary generator.
    const leftover = leftoverProse(text, { sorszam });
    const leftoverTokens = leftover ? leftover.split(/\s+/).filter((t) => t.length >= 2) : [];
    const szQ = leftoverTokens.length >= 2 ? leftover : undefined;
    return {
      intent: "find_ticket_by_sorszam",
      primitive: "find_ticket_by_sorszam",
      filters: { sorszam, ...(szQ ? { q: szQ } : {}) },
      follow_ups: fu(language, "search_tickets", [
        "Mik a legutóbbi ticketjeik?",
        "Milyen kategóriájú hibák jellemzőek erre az ügyfélre?",
      ]),
      rationale: "explicit sorszam -> direct lookup",
    };
  }

  // ---- Meta / capabilities ----
  if (has(text, "mit tudsz", "mire vagy kepes", "mire vagy képes", "what can you", "what do you know", "capabilities", "leiras", "leírás")) {
    return {
      intent: "get_categories",
      primitive: "get_categories",
      filters: {},
      follow_ups: fu(language, "search_tickets", [
        "Mutasd a kategóriákat",
        "Hogyan működik a keresés?",
      ]),
      rationale: "meta question -> capabilities",
    };
  }
  if (has(text, "kategoriak", "kategóriák", "categories")) {
    return {
      intent: "get_categories",
      primitive: "get_categories",
      filters: {},
      follow_ups: fu(language, "top_kategoriak_inferred", [
        "Melyik kategóriába esik a legtöbb ticket?",
        "Mutasd a vezérlő hibákat",
      ]),
      rationale: "kategoria list request",
    };
  }
  if (has(text, "cimkek", "címkék", "tags")) {
    return {
      intent: "get_tags",
      primitive: "get_tags",
      filters: {},
      follow_ups: fu(language, "search_tickets", [
        "Mutasd a kategóriákat is",
      ]),
      rationale: "tag list request",
    };
  }

  // ---- Recurring / pattern ----
  if (has(text, "ismetles", "ismétlés", "ismétlodo", "ismétlődő", "visszajaro", "visszajáró", "visszater", "visszatér", "vissza ter", "ter vissza", "visszatero", "visszatérő", "recurring", "keeps happening", "kezd elolrol", "kezdi elölről", "regress", "gyakori hiba", "makacs", "visszaeses", "visszaesés", "rendszeresen", "ujra es", "újra elő", "megismetl", "megismétl")) {
    return {
      intent: "find_pattern",
      primitive: "find_recurring_problems",
      filters: f,
      period,
      follow_ups: fu(language, "search_tickets", [
        "Melyik ügyfél problémája a legmakacsabb?",
        "Volt-e visszaesés egy korábban megoldott hibánál?",
      ]),
      rationale: "recurring / pattern question",
    };
  }

  // ---- Top "hub" tickets (Phase 5b) ----
  // The linkage index gives us ticket-on-ticket references. A ticket
  // that's mentioned by the most other tickets is a strong "central
  // work order" candidate — useful for "melyik munkához jártunk ki
  // a legtöbbször?" where the user means "which big case had the
  // most follow-up visits linked to it", not just raw ticket count.
  if (has(text, "melyik munkahoz", "melyik munkához", "melyik munka", "legnagyobb munka", "legtobb kiszallas ehhez", "legtöbb kiszállás ehhez", "fo munkarend", "fő munkarend", "hub", "centralis munka", "centrális munka", "legtobb alkalommal", "legtöbb alkalommal", "melyik ticketre", "which work order", "which job had the most", "central case", "hub ticket")) {
    return {
      intent: "top_hubs",
      primitive: "top_hubs",
      filters: f,
      period,
      follow_ups: fu(language, "top_hubs", [
        "Mutasd a top hub ticket részleteit",
        "Melyik ügyfélhez tartozik a legnagyobb hub?",
      ]),
      rationale: "top hub tickets by linkage indegree",
    };
  }

  // ---- Internal archive / workshop / spare motors / failure rates ----
  if (has(text, "szerviz belso", "szerviz belső", "internal ticket", "j-sorszam", "j-sorszám")) {
    return {
      intent: "search_internal",
      primitive: "search_serviz_archive",
      filters: f,
      period,
      follow_ups: fu(language, "search_tickets", [
        "Milyen szerviz belső ticketjeink vannak idén?",
        "Mutasd az utolsó 10 belső ticketet",
      ]),
      rationale: "internal archive lookup",
    };
  }
  if (has(text, "szev", "igenyles", "igénylés", "requisition")) {
    return {
      intent: "search_szev",
      primitive: "search_szev_igeny",
      filters: f,
      period,
      follow_ups: fu(language, "count_by_status", [
        "Milyen státuszú SZÉV-k vannak most?",
        "Melyik beszállítótól mit rendelünk gyakran?",
      ]),
      rationale: "SZÉV requisition",
    };
  }
  if (has(text, "telephely", "workshop job", "telephelyi munka")) {
    return {
      intent: "search_telephely",
      primitive: "search_telephely_munka",
      filters: f,
      follow_ups: fu(language, "search_tickets", [
        "Melyik telephelyi munkánk van folyamatban?",
        "Mennyi munkaórát töltöttünk telephelyen idén?",
      ]),
      rationale: "telephely workshop",
    };
  }
  if (has(text, "potmotor", "pótmotor", "tartalek motor", "tartalék motor", "spare motor", "ai-s motor", "ais motor", "zarolt motor", "zárlatos motor", "zarolt", "zárlatos") && has(text, "motor", "raktar", "raktár", "keszlet", "készlet", "spare")) {
    return {
      intent: "find_spare_motor",
      primitive: "find_spare_motor",
      filters: f,
      follow_ups: fu(language, "search_tickets", [
        "Melyik NCT motor zárlatos most a raktárban?",
        "Van-e AiS100 pótmotorunk ehhez a géphez?",
      ]),
      rationale: "spare motor lookup",
    };
  }
  if (has(text, "meghibasodasi arany", "meghibásodási arány", "failure rate", "garancialis arany", "garanciális arány", "factory failure")) {
    return {
      intent: "failure_rates",
      primitive: "get_failure_rates",
      filters: f,
      period,
      follow_ups: fu(language, "search_tickets", [
        "Mekkora a DxC hajtások meghibásodási aránya 2024-ben?",
        "Melyik termék a legrosszabb most?",
      ]),
      rationale: "factory failure rates",
    };
  }

  // ---- Related / continuation (after archive-specific branches so
  // "telephelyi munka kapcsolódik" still routes to search_telephely) ----
  if (has(text, "folytatas", "folytatás", "elozmeny", "előzmény", "összefüggés", "osszefugg", "kapcsolodo", "kapcsolód", "utana", "utána", "elotte", "előtte", "kovetkez", "következ", "tortenet", "történet", "minden rola", "minden róla", "related", "follow-up", "followup", "continuation", "history", "preceding", "preceding ticket")) {
    return {
      intent: "find_related",
      primitive: "find_related_tickets",
      filters: f,
      period,
      follow_ups: fu(language, "find_related", [
        "Mutasd a teljes történetet",
        "Van-e nyitott ticket még ugyanerre a gépre?",
      ]),
      rationale: "related / continuation lookup",
    };
  }

  // ---- Critical / open counts ----
  // Note: "critical" is the English spelling; "kritikus" is Hungarian;
  // "kritical" is a common misspelling. All three must trigger the
  // same branch or the router is language-biased. See Phase 3
  // regression test #bilingual-critical.
  if (has(text, "kritikus", "kritical", "critical") && has(text, "jelenleg", "most", "mostanában", "mostanaban", "now", "currently", "right now")) {
    return {
      intent: "critical_open_now",
      primitive: "stats",
      group_by: "customer",
      filters: { ...f, sulyossag_inferred: "kritikus", status: "open" },
      period: period ?? "this_month",
      order: "count_desc",
      follow_ups: fu(language, "critical_open_now", [
        "Mutasd a kritikus ticketeket",
        "Melyik ügyfélnek van a legtöbb nyitott ticketje?",
      ]),
      rationale: "critical-open-now",
    };
  }
  if (has(text, "kritikus", "kritical", "critical") && (customer || has(text, "mennyi", "hany", "how many"))) {
    return {
      intent: "top_customer_critical_tickets",
      primitive: "stats",
      group_by: "customer",
      filters: { ...f, sulyossag_inferred: "kritikus" },
      period,
      order: "count_desc",
      follow_ups: fu(language, "critical_open_now", [
        "Mutasd ezeket a kritikus ticketeket",
        "Melyik kategóriába tartoznak?",
      ]),
      rationale: "critical tickets",
    };
  }
  if (has(text, "nyitott", "open") && has(text, "ticket", "jegy", "bejelentes", "bejelentés") && (customer || has(text, "mennyi", "hany", "how many") || has(text, "legtobb", "legkevesebb", "legnagyobb", "legkisebb", "melyik", "which", "ki"))) {
    return {
      intent: "top_customer_open_tickets",
      primitive: "stats",
      group_by: "customer",
      filters: { ...f, status: "open" },
      period,
      order: "count_desc",
      follow_ups: fu(language, "top_customer_open_tickets", [
        "Mutasd a legrégebbi nyitott ticketeket",
        "Melyik technikus kezeli ezeket?",
      ]),
      rationale: "open tickets",
    };
  }

  // ---- Top-N aggregations ----
  if (has(text, "ugyfel", "ügyfél", "customer", "ceg", "cég", "kinek járunk", "kihez járunk", "kihez jarunk", "kinek megyunk", "kinek megyünk", "legtobb kiszallas", "legtöbb kiszállás", "kinek szolgaltatunk")) {
    return {
      intent: period ? "top_customers_in_period" : "top_customers",
      primitive: "stats",
      group_by: "customer",
      filters: f,
      period,
      limit: topN ?? 10,
      order: "count_desc",
      follow_ups: fu(language, "top_customers", [
        "Melyik ügyfélnek van a legtöbb nyitott ticketje?",
        "Melyik ügyfélhez milyen gépeket szervízelünk?",
      ]),
      rationale: "top customers",
    };
  }

  if (has(text, "gep tipus", "gép típus", "machine type", "geptipus", "leggyakoribb gephiba", "leggyakoribb géphiba", "melyik gep megy", "melyik gép megy", "melyik gep tonkre", "melyik gép tönkre", "which machine", "what machine")) {
    return {
      intent: "top_machine_type",
      primitive: "stats",
      group_by: "machine_type",
      filters: f,
      period,
      limit: topN ?? 10,
      order: "count_desc",
      follow_ups: fu(language, "top_machine_type", [
        "Melyik vezérlő okozza a legtöbb hibát?",
        "Melyik a leggyakoribb hibakategória?",
      ]),
      rationale: "top machine type",
    };
  }

  if (has(text, "vezerlo", "vezérlő", "controller", "nc vezerlo", "nc vezérlő")) {
    return {
      intent: "top_controllers",
      primitive: "stats",
      group_by: "controller",
      filters: f,
      period,
      limit: topN ?? 10,
      order: "count_desc",
      follow_ups: fu(language, "top_controllers", [
        "NCT104 szoftveres hibák",
        "Melyik gép megy legtöbbször tönkre?",
      ]),
      rationale: "top controllers",
    };
  }

  if (has(text, "kategoria", "kategória", "category", "hibakategoria", "hibakategória", "hibatipus", "hibatípus")) {
    return {
      intent: "top_kategoriak_inferred",
      primitive: "stats",
      group_by: "kategoria_inferred",
      filters: f,
      period,
      limit: topN ?? 10,
      order: "count_desc",
      follow_ups: fu(language, "top_kategoriak_inferred", [
        "Mutasd a szoftver hibákat",
        "Melyik kategória növekszik?",
      ]),
      rationale: "top kategoria (inferred)",
    };
  }

  if (has(text, "sulyossag", "súlyosság", "severity")) {
    return {
      intent: "top_sulyossag",
      primitive: "stats",
      group_by: "sulyossag_inferred",
      filters: f,
      period,
      order: "count_desc",
      follow_ups: fu(language, "top_sulyossag", [
        "Mutasd a kritikus ticketeket",
        "Melyik ügyfélnek van a legtöbb kritikus ticketje?",
      ]),
      rationale: "sulyossag distribution",
    };
  }

  if (has(text, "technikus", "technician", "dolgozo", "dolgozó")) {
    if (has(text, "nyitott", "open")) {
      return {
        intent: "top_technicians_open",
        primitive: "stats",
        group_by: "technician",
        filters: { ...f, status: "open" },
        period,
        limit: topN ?? 10,
        order: "count_desc",
        follow_ups: fu(language, "top_technicians_open", [
          "Melyik technikus melyik vezérlőhöz ért a legjobban?",
        ]),
        rationale: "top technicians open",
      };
    }
    return {
      intent: "top_technicians",
      primitive: "stats",
      group_by: "technician",
      filters: f,
      period,
      limit: topN ?? 10,
      order: "count_desc",
      follow_ups: fu(language, "top_technicians", [
        "Melyik technikus hány ticketet zárt le?",
        "Melyik technikusnak van a legtöbb nyitott ticketje?",
      ]),
      rationale: "top technicians",
    };
  }

  if (has(text, "statusz", "státusz", "allapot", "állapot", "open", "closed", "lezart", "lezárt", "zart", "zárt", "nyitott", "folyamatban", "status")) {
    return {
      intent: "count_by_status",
      primitive: "stats",
      group_by: "status",
      filters: f,
      period,
      order: "count_desc",
      follow_ups: fu(language, "count_by_status", [
        "Mutasd a nyitott ticketeket",
        "Hány kritikus van most?",
      ]),
      rationale: "count by status",
    };
  }

  if (has(text, "honap", "hónap", "month", "per month", "ticket per month")) {
    return {
      intent: "count_by_month",
      primitive: "stats",
      group_by: "month",
      filters: f,
      period: period ?? "last_year",
      order: "count_desc",
      follow_ups: fu(language, "count_by_month", [
        "Melyik a 3 legrosszabb hónap?",
        "Mekkora a krízis-trend?",
      ]),
      rationale: "count by month",
    };
  }

  // ---- Single-customer drill-down ----
  if (customer && !has(text, "legjobb", "legtobb", "legkevesebb", "top")) {
    if (has(text, "kritikus", "kritical")) {
      return {
        intent: "customer_open_count",
        primitive: "search_tickets",
        filters: { customer, sulyossag_inferred: "kritikus" },
        period,
        follow_ups: fu(language, "search_tickets", [
          "Mutasd a kritikus ticketjeiket",
          "Milyen kategóriájú hibáik vannak?",
        ]),
        rationale: "customer critical tickets",
      };
    }
    if (has(text, "gep", "gép", "device", "machine")) {
      return {
        intent: "customer_top_devices",
        primitive: "stats",
        group_by: "machine_type",
        filters: { customer },
        period,
        limit: 10,
        order: "count_desc",
        follow_ups: fu(language, "top_machine_type", [
          "Melyik gépükkel van a legtöbb baj?",
          "Mikor volt utoljára náluk javítás?",
        ]),
        rationale: "customer top devices",
      };
    }
    if (has(text, "kategoria", "kategória", "hiba")) {
      return {
        intent: "customer_top_kategoriak",
        primitive: "stats",
        group_by: "kategoria_inferred",
        filters: { customer },
        period,
        limit: 10,
        order: "count_desc",
        follow_ups: fu(language, "top_kategoriak_inferred", [
          "Mutasd a szoftver hibáikat",
          "Melyik technikus szervízeli őket?",
        ]),
        rationale: "customer top kategoria",
      };
    }
    if (has(text, "utoljara", "utoljára", "utolso", "utolsó", "last", "when")) {
      return {
        intent: "customer_last_seen",
        primitive: "search_tickets",
        filters: { customer },
        period,
        limit: 1,
        order: "recent_desc",
        follow_ups: fu(language, "search_tickets", [
          "Mutasd az utolsó 5 ticketjüket",
          "Milyen gépeket szervízelünk náluk?",
        ]),
        rationale: "customer last_seen",
      };
    }
    if (has(text, "technikus", "ki szervizel", "ki szervízel")) {
      return {
        intent: "customer_top_technicians",
        primitive: "stats",
        group_by: "technician",
        filters: { customer },
        period,
        limit: 10,
        order: "count_desc",
        follow_ups: fu(language, "top_technicians", [
          "Mutasd az utolsó 10 ticketjüket",
          "Milyen kategóriájú hibáik vannak?",
        ]),
        rationale: "customer top technicians",
      };
    }
    return {
      intent: "customer_tickets_list",
      primitive: "search_tickets",
      filters: { customer },
      period,
      limit: 20,
      order: "recent_desc",
      follow_ups: fu(language, "search_tickets", [
        "Milyen kategóriájú hibáik vannak?",
        "Mikor volt utoljára náluk javítás?",
      ]),
      rationale: "customer ticket list",
    };
  }

  // ---- Single-device drill-down ----
  if (device) {
    // Thread the leftover prose into the search so questions like
    // "X tengely golyos orso csapágyak M09192 munkánál" don't lose the
    // "X tengely golyos orso csapágyak" part. The cache currently ANDs
    // q tokens, so we only forward a leftover with substantive tokens
    // (>=2) — otherwise bare device questions like "M09192 ticketjei"
    // would over-filter.
    const leftover = leftoverProse(text, { device });
    const leftoverTokens = leftover ? leftover.split(/\s+/).filter((t) => t.length >= 2) : [];
    const devQ = leftoverTokens.length >= 2 ? leftover : undefined;
    if (has(text, "leggyakoribb", "legjellemzőbb", "mi a baja", "mi a hibaja", "most common", "what's wrong")) {
      return {
        intent: "device_top_problem",
        primitive: "stats",
        group_by: "kategoria_inferred",
        filters: { device, ...(devQ ? { q: devQ } : {}) },
        period: period ?? "last_year",
        limit: 5,
        order: "count_desc",
        follow_ups: fu(language, "search_tickets", [
          "Mutasd a legutóbbi ticketjeit",
          "Melyik ügyfélnél van belőle a legtöbb?",
        ]),
        rationale: "device top problem",
      };
    }
    if (has(text, "hany", "hány", "how many", "count")) {
      return {
        intent: "device_total_count",
        primitive: "stats",
        group_by: "device",
        filters: { device, ...(devQ ? { q: devQ } : {}) },
        period,
        follow_ups: fu(language, "search_tickets", [
          "Melyik a leggyakoribb hibája?",
          "Mutasd az utolsó 5 ticketjét",
        ]),
        rationale: "device count",
      };
    }
    return {
      intent: "device_tickets_list",
      primitive: "search_tickets",
      filters: { device, ...(devQ ? { q: devQ } : {}) },
      period,
      limit: 20,
      order: "recent_desc",
      follow_ups: fu(language, "search_tickets", [
        "Mi a leggyakoribb hibája?",
        "Melyik ügyfélnél van belőle a legtöbb?",
      ]),
      rationale: "device ticket list",
    };
  }

  // ---- Free-text search fallback ----
  if (text.length >= 3) {
    return {
      intent: "search_tickets",
      primitive: "search_tickets",
      filters: { ...f, q: text },
      period,
      limit: 20,
      order: "recent_desc",
      follow_ups: fu(language, "search_tickets", [
        "Mutasd az első 5 találatot",
        "Csak a kritikus ticketeket szeretném látni",
      ]),
      rationale: "free-text fallback",
    };
  }

  return {
    intent: "needs_clarification",
    primitive: "search_tickets",
    filters: {},
    follow_ups: fu(language, "needs_clarification", [
      "Melyik ügyfélhez járunk a legtöbbet?",
      "Mutasd a TMV-400-as ticketeket",
      "Hány kritikus ticket van most?",
    ]),
    rationale: "too vague, asked for clarification",
  };
}
