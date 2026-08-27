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

import { huDefiniteArticle } from "./hu";

import { huDefiniteArticle } from "./hu";

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
  | "customer_fleet_overview"
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
  | "problem_solution"
  | "part_spec"
  | "problem_solution"
  | "part_spec"
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
  /** Explicit date window extracted from the question (e.g. "napjainktól 2024.05.10-ig"). */
  date_from?: string;
  date_to?: string;
  /** Explicit date window extracted from the question (e.g. "napjainktól 2024.05.10-ig"). */
  date_from?: string;
  date_to?: string;
  limit?: number;
  order?: "count_desc" | "recent_desc";
  follow_ups: string[]; // suggested next questions in user's language
  rationale: string; // short hu/en explanation, surfaced in logs
  /**
   * Phase 6: when the customer was extracted by the WEAK (4th) pattern
   * — a bare ALL-CAPS phrase like "SVG HDMC" or "ContiTech" — the answer
   * handler MUST run a `search_customers` DB probe before honoring the
   * customer filter. If 0 customers match, the filter is discarded and
   * the question falls through to the device / free-text branch.
   */
  weak_customer?: string;
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

// ---------------------------------------------------------------------------
// Explicit date extraction
// ---------------------------------------------------------------------------
// The named-period detector above knows "tavaly" / "last_30_days" etc., but
// users also ask with concrete dates: "napjainktól 2024.05.10-ig visszamenőleg"
// ("from today back to 2024.05.10"), "2024.01.01-től 2024.12.31-ig",
// "from 2024-05-10 to 2024-06-01", "until 2024-05-10". Without this, the
// router silently ignored the window and reported "minden idők".
//
// Accepts YYYY.MM.DD / YYYY-MM-DD / YYYY/MM/DD (also "YYYY. MM. DD." with
// spaces / trailing dot). Direction words decide which bound each date is:
//   - "visszamenőleg"/"napjainktól" + "-ig" date  → from = date, to = today
//     (Hungarian: "napjainktól X-ig visszamenőleg" = going back until X)
//   - "-ig"/"until"/"till" (also "until 2024-05-10" before the date)
//                                                       → date_to = date
//   - "-től"/"-tól"/"óta"/"since"/"from" (also "from 2024-05-10")
//                                                       → date_from = date
//   - two dates (X-től Y-ig / between X and Y)   → from = min, to = max
//   - bare single date                           → exact day (from = to = date)

export function detectExplicitDates(
  text: string,
  now: Date = new Date(),
): { date_from?: string; date_to?: string } | undefined {
  const dateRe = /\b(20\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})\b/g;
  const found: { iso: string; idx: number; len: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = dateRe.exec(text)) !== null) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    found.push({ iso, idx: m.index, len: m[0].length });
  }
  if (found.length === 0) return undefined;

  const todayIso = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;

  if (found.length >= 2) {
    const sorted = found.map((f) => f.iso).sort();
    return { date_from: sorted[0], date_to: sorted[sorted.length - 1] };
  }

  const one = found[0];
  const after = text.slice(one.idx + one.len, one.idx + one.len + 6); // just past the date
  const afterNorm = norm(after);
  const before = text.slice(Math.max(0, one.idx - 12), one.idx); // text right before the date
  const beforeNorm = norm(before);
  const n = norm(text);

  // Leading whitespace is allowed before the dash: a spaced date
  // ("2024. 05. 10.-ig") produces after = ".-ig", which normalizes to
  // " -ig" (the trailing separator dot becomes a space).
  const hasIg = /^\s*-?\s*(ig|until|till)\b/.test(afterNorm);
  const hasFrom = /^\s*-?\s*(től|tol|óta|ota|since|from|kezdve)\b/.test(afterNorm);
  // English direction words come BEFORE the date ("until 2024-05-10",
  // "since 2024-05-10"), unlike Hungarian suffixes ("2024.05.10-ig").
  const beforeTo = /(until|till)\s*$/.test(beforeNorm);
  const beforeFrom = /(since|from)\s*$/.test(beforeNorm);
  const goingBack = n.includes("visszamenoleg") || n.includes("napjainktol") || n.includes("visszamenőleg") || n.includes("napjainktól");

  if (hasIg && goingBack) {
    // "napjainktól 2024.05.10-ig visszamenőleg" — from that date to today.
    return { date_from: one.iso, date_to: todayIso };
  }
  if (hasIg || beforeTo) return { date_to: one.iso };
  if (hasFrom || beforeFrom) return { date_from: one.iso };
  // Bare date → exact day.
  return { date_from: one.iso, date_to: one.iso };
}

/**
 * Customer extraction result.
 *   `name`  - the matched phrase (Kft.-style canonical or bare phrase)
 *   `weak`  - true when the match came from the 4th (bare ALL-CAPS) pattern
 *             and has NOT been validated against the customers table. The
 *             answer handler (answer.ts) runs a `search_customers` DB
 *             probe; a 0-hit probe discards the weak signal and the
 *             question falls through to whatever branch would have
 *             fired without the customer filter.
 */
export type CustomerMatch = { name: string; weak: boolean };

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

/**
 * Extract a "weak" customer match: a 1-3 token phrase where every token
 * starts with a capital letter but no legal suffix / -nél suffix is
 * present. Examples that fire: "SVG HDMC", "ContiTech", "Gildemeister
 * Hungary", "MÁV TR". False positives are accepted here because the
 * answer handler runs a cheap `search_customers` DB probe to confirm.
 *
 * What is excluded:
 *   - Question words ("Melyik", "Mikor", "Hány", "Milyen", "Mit",
 *     "Mennyi", "Hogyan", "Volt") — these are well-known Hungarian /
 *     English interrogatives that happen to be capitalized at the
 *     start of the question.
 *   - Tokens that match the device extractor (M-serial, model codes
 *     like "TMV-400", "NCT104", "DPB-3-40-80"). The router already
 *     runs the device extractor first; this extractor is only the
 *     "leftover" capital-initial phrase.
 */
function extractWeakCustomer(text: string): string | undefined {
  // The 1-3 token phrase. PURE LETTERS ONLY — no digits anywhere in
  // the token. M-serials like M10170 split on the digit-to-letter
  // boundary, so the phrase captures "M" alone which we then reject
  // (see model-prefix check below). Same for "TMV" / "NCT104" /
  // "DPB-3" — the digit kills the token match, so the device code
  // never reaches here. For "TMV" alone (no digit), the model-prefix
  // check rejects it.
  const token = "[A-ZÁÉÍÓÖŐÚÜŰ][A-ZÁÉÍÓÖŐÚÜŰa-záéíóöőúüű&.\\-]{1,30}";
  const phrase = `\\b(?:${token})(?:\\s+${token}){0,2}\\b`;
  // Question-word leaders we must NOT capture. Comprehensive list of
  // Hungarian and English interrogatives + common dashboard action
  // verbs that look like customer names but are actually commands.
  const LEADERS = [
    "Melyik", "Mikor", "Mennyi", "Hány", "Hany", "Hányszor", "Hanyzor", "Mekkora", "Mekk",
    "Milyen", "Mely", "Mit", "Minek", "Miert", "Miért", "Miert",
    "Hogyan", "Hogy", "Volt", "Voltak", "Hova", "Honnan", "Hol",
    "Mióta", "Meddig", "Mettol", "Mettől",
    "Ki", "Kicsoda", "Kinek", "Melyiket", "Melyikbe",
    "Adj", "Ajanl", "Ajánl", "Hozz", "Torolj", "Törölj", "Torold", "Töröld", "Zard", "Zárd",
    "Mondj", "Mesélj", "List", "Show", "Tell",
    "Mutasd", "Mutatni", "Mutasd meg", "Kerdes", "Kérdés",
    "Mi", "Miert", "Miért", "Melyek",
    // Hungarian adverbs/verbs that get capitalized at sentence start.
    "Jobbak", "Rosszabbak", "Jók", "Rosszak", "Nagyok", "Kicsik",
    "Újak", "Új", "Régi", "Régiek", "Újat", "Régit",
    "Vannak", "Vannak", "Lesznek", "Maradnak", "Válnak", "Változnak",
    "Foglald", "Foglalja", "Összegzi", "Összefoglalni", "Foglalja",
    "Csinal", "Csináld", "Csinálj", "Csinálja", "Csinál",
    "Küld", "Küldj", "Küldd", "Küldje",
    "Indít", "Indítsd", "Inditsd", "Indíts", "Indits",
    "Készíts", "Készítsd", "Keszits", "Keszitsd", "Készíteni",
    "Készült", "Keszult", "Készül",
    "Értékelj", "Értékeld", "Ertekelj", "Ertekeld", "Értékel",
    "Elemezz", "Elemezd", "Elemezzed", "Elemezes",
    // Hungarian question/auxiliary verbs that get capitalized at
    // the start of a question ("Van-e service manual...").
    "Van-e", "Vane", "Tud", "Tudom", "Tudod", "Tudja", "Tudnak",
    "Van", "Vannak", "Lesz", "Voltam", "Volt", "Voltál",
    "Volt-e", "Volte", "Voltak-e", "Voltake",
    "Fog", "Fognak", "Szeretne", "Szeretnél", "Szeretném",
    "Tudsz", "Tudjuk", "Tudjátok", "Tudják",
    // Hungarian polite request openers — "Kérem az M17191 gép előéletét"
    // would extract "Kérem" as a weak customer without this guard.
    "Kérem", "Kerem", "Kérlek", "Kerlek", "Kérek", "Kerek",
    "Kérjük", "Kerjuk", "Kérünk", "Kerunk",
    // Common industrial/machine nouns that start sentences in CMMS
    // context — "Gép előélet" / "Gép javítás" would extract "Gép" as
    // a weak customer without this guard. Also covers the [Gép: M17191]
    // context prefix injected by the machine selector.
    "Gép", "Gep", "Gépek", "Gepek", "Gépet", "Gepet", "Gépem", "Gepem",
    "Hiba", "Javitas", "Javítás", "Szerviz", "Karban", "Karbantartas",
    "Karbantartás", "Telepites", "Telepítés", "Csere", "Cseréljük",
    "Csereljuk", "Előélet", "Eloélet", "Allapot", "Állapot",
    // Hungarian demonstratives + adverbs that look like customer
    // names when capitalized at the start of a sentence.
    "Ezzel", "Azza", "Azzal", "Erre", "Arra", "Ezek", "Azok",
    "Ezt", "Azt", "Ide", "Oda", "Igy", "Igy", "Úgy", "Ugy",
    "Ennek", "Annak", "Ebbol", "Abol", "Ebbe", "Abba",
    "Már", "Mar", "Most", "Itt", "Ott", "Akkor", "Akkor",
    // English demonstratives
    "This", "That", "These", "Those", "Here", "There",
    "Which", "What", "When", "How", "Who", "Whose", "Where", "Why",
  ];
  // The device-model prefix regex (without the trailing digit group).
  // A "TMV" or "NCT" or "DPB" or "DxC" alone is a model code, not a
  // customer. "dpb" isn't currently in the device extractor's regex
  // (the extractor's "d[abns]" only matches 2-letter d-codes: DA, DB,
  // DN, DS) but treating DPB/DxC as a model here prevents
  // false-positive customer captures like "DPB-3-40-80" → "DPB-".
  const MODEL_PREFIX_RE = /^(?:nct|tmv|dpx?|dpa|dpb|dpn|dps|dxc|dxa|dxn|dxs|d[abns]|few|ips|ihdw|kafo|eml|emr|veu|vd|bnc)$/i;
  const re = new RegExp(phrase, "g");
  const leadersLower = new Set(LEADERS.map((w) => w.toLowerCase()));
  const articles = new Set(["az", "a"]);
  for (const m of text.matchAll(re)) {
    const candidate = m[0].trim();
    if (!candidate) continue;
    if (articles.has(candidate.toLowerCase())) continue;
    if (leadersLower.has(candidate.toLowerCase())) continue;
    // Skip if the FIRST token of the candidate is itself a leader
    // ("Mikor Y2 hajtás" — would happen if the question has weird
    // punctuation or the question begins with a leader).
    const first = candidate.split(/\s+/)[0].toLowerCase();
    if (leadersLower.has(first)) continue;
    // Reject any single token that's a model prefix (TMV, NCT, ...)
    // — those are device codes, not customers. The token regex is
    // already digit-free, so M10170's "M" prefix is captured alone
    // (not "M10170" as one token) and rejected here. We also strip
    // trailing punctuation (hyphens, dots) so a split like
    // "TMV-" (from "TMV-400") is correctly caught.
    if (candidate.split(/\s+/).some((t) => MODEL_PREFIX_RE.test(t.replace(/[.\-]+$/, "")))) continue;
    // Reject single-letter tokens (X, Y, Z, A, B, …) — those are
    // axis labels or part-prefixes, not customer names. Common
    // shaft/axis labels: "X", "Y", "Z", "A", "B" + optional suffix.
    if (candidate.split(/\s+/).every((t) => t.length <= 1)) continue;
    // Reject common axis / part / coordinate labels even when they
    // appear with a suffix (e.g. "Y-tengely", "X-orsó").
    const AXIS_LABEL_RE = /^(?:[XYZ]|A|B|C)(?:[\-][A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]+)?$/i;
    if (candidate.split(/\s+/).every((t) => AXIS_LABEL_RE.test(t))) continue;
    // Reject single-token garbage that doesn't look like a real word
    // (3+ identical consecutive letters is a strong signal of typing
    // noise / nonsense). The Hubbbubbbla regression test exercises
    // this: 3 consecutive 'b's in a row is a typo, not a customer.
    if (/(.)\1{2,}/i.test(candidate)) continue;
    // Length floor.
    if (candidate.length < 3) continue;
    return candidate;
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

// ---------------------------------------------------------------------------
// Symptom-statement detection ("Elsötétült az NCT 204 kijelzője")
// ---------------------------------------------------------------------------
// The request-phrase trigger ("hogyan tudom megjavítani?") catches
// explicit problem-solution questions, but a bare symptom statement —
// the most natural way a person describes a broken machine — used to
// fall through to the device branch and come back as a hit counter
// ("7044 találat minden idők. Az első sorszám: B26072006."). That is
// the single most important answer type, so we also trigger on fault
// language: state/verb words ("elsötétült", "nem indul", "füstöl")
// in the leftover prose, NOT on neutral part names ("csapágy") or
// question-word forms ("Mi a leggyakoribb hibája...?"), which have
// their own intents.

// Single-word symptoms (folded). Tokens match when they share a
// >=5-char prefix with a keyword (handles declined forms AND the
// user's habitual typos: "elsötéltült" shares "elsot" with
// "elsötétült"); keywords shorter than 5 chars match exactly.
const SYMPTOM_WORDS: string[] = [
  // hu
  "elsotetult", "elromlott", "lerobbant", "leallt", "megallt", "beragadt",
  "beszorult", "fustol", "tulmelegszik", "melegszik", "zarlat", "lemerult",
  "elszakadt", "elolvadt", "kialszik", "villog", "sikit", "vibral", "remeg",
  "ugral", "reszket", "meghibasodott", "kikapcsol", "hibas", "zug",
  // display/screen symptoms: the user's noun-phrase phrasing ("NCT204
  // sötét kijelző", "kijelző hiba") never matched the verb-only set
  // ("elsötétült") and fell through to a bare hit counter. Prefix
  // matching covers declined forms: "kijelzője" / "kijelzés" share
  // "kijel" with "kijelzo"; "sötétedik" shares "sotet" with "sotet".
  "sotet", "kijelzo", "kepernyo", "fekete", "lefagy",
  // en
  "overheat", "smoke", "flicker", "broken", "stuck", "frozen", "blank",
  "darken", "dark", "dead", "fault", "buzzing", "display", "screen", "black",
];

// Multi-word symptoms (folded, apostrophes stripped): "nem indul",
// "nincs kép", "hibauzenet"... Word-bounded so "nem induló" (a noun
// phrase, not a fault statement) does not match "nem indul".
const SYMPTOM_PHRASES: string[] = [
  // hu
  "nem indul", "nem mukodik", "nem kapcsol", "nem vilagit", "nem forog",
  "nem reagal", "nem tolt", "nem nyilik", "nem zar", "nem birja",
  "nincs kep", "nincs feny", "nincs feszultseg", "nincs tapa", "nincs erintkezes",
  "nincs kijelzes", "nem jelenik meg", "hibauzenet", "hibat jelez", "hibat ir",
  "magatol kikapcsol", "nem lehet bekapcsolni", "nem tud bekapcsolni",
  "nem tudok bekapcsolni", "nem indul el", "nem indul be",
  // en
  "not working", "not starting", "not turning on", "does not start",
  "doesnt start", "wont start", "wont turn on", "does not turn on",
  "not charging", "wont charge", "not responding", "not loading",
  "no power", "no display", "no picture", "short circuit",
  "turns off", "shuts off",
];

// Compiled once at module load.
const SYMPTOM_PHRASE_RE: RegExp[] = SYMPTOM_PHRASES.map(
  (p) => new RegExp(`\\b${p}\\b`),
);

function hasSymptom(foldedLeftover: string): boolean {
  if (!foldedLeftover) return false;
  const flat = foldedLeftover.replace(/'/g, "");
  for (const re of SYMPTOM_PHRASE_RE) {
    if (re.test(flat)) return true;
  }
  const tokens = flat.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    for (const w of SYMPTOM_WORDS) {
      if (w.length >= 5 ? tok.startsWith(w.slice(0, 5)) : tok === w) return true;
    }
  }
  return false;
}

// Question-word / request leaders. If the text STARTS with one of
// these, it is a question form ("Mi a leggyakoribb hibája...?"),
// a list request ("Mutasd a ... ticketjeit") or a yes/no question
// ("Van-e ...?") — not a symptom statement. Tested against the
// normed (folded, punctuation-stripped) text, so "van-e" -> "van e".
const QUESTION_LEADERS: RegExp =
  /^(mi\b|miert|melyik|mely\b|mennyi|hany|mikor|milyen|mit\b|mire|ki\b|kik|hol\b|hova|honnan|merre|meddig|mikortol|mirol|milyet|milyek|mik\b|melyek|van e|lehet e|volt e|mutass|mutasd|keres|keress|listazd|sorold|sorolj|adj\b|add\b|what\b|which\b|when\b|where\b|who\b|how\b|show\b|list\b|find\b|is there|are there|can you|could you|do you|does\b)/i;

function isQuestionLeader(text: string): boolean {
  return QUESTION_LEADERS.test(norm(text));
}

// ---------------------------------------------------------------------------
// Part-spec questions ("X tengely golyósorsó csapágyak típusa és mennyisége")
// ---------------------------------------------------------------------------
// A part-spec question names a machine part (csapágy, golyósorsó, szíj, ...)
// AND asks for its specification (típusa, mennyisége, mérete, ... — or just
// "milyen/melyik/mekkora"). The old behavior dropped to a device ticket
// list and answered with a hit counter ("50 találat minden idők. Az első
// sorszám: B26061810.") even though the spec (e.g. "4 db 30TAC62CSUHPN7C")
// sits in a work note. The answer path extracts it from the notes.
//
// NOT guarded by question-word leaders — "Milyen csapágy...?" IS a spec
// question. But guarded against intents that merely look like part+spec:
//   - frequency/stats ("Melyik csapágy hibásodik meg a leggyakrabban?")
//   - requisitions ("Milyen alkatrészeket rendeltünk...?")
//   - spare-motor stock ("Melyik NCT motor zárlatos most a raktárban?")
// Attribute vocabulary (vezérlés/vezérlő/szoftver/modell/géptípus/szervó)
// is deliberately absent so existing attribute answers keep their path.

const PART_SPEC_WORDS: string[] = [
  // hu (folded)
  "csapagy", "golyosorso", "orso", "szij", "kuplung", "tengelykapcsolo",
  "tomites", "tapegyseg", "rele", "biztositek", "alkatresz", "csavar",
  "gyuru", "ventillator", "kijelzo", "kepernyo", "monitor", "akku",
  "elem", "motor", "pumpa", "szivattyu", "heveder", "lanc", "fogaskerek",
  "szenkefe", "merocella", "kodolo", "kontakt", "potenciometer", "tengely",
];

const PART_SPEC_SPEC_WORDS: string[] = [
  // hu (folded) — "típusa" -> "tipusa" starts with "tipus"
  "tipus", "mennyiseg", "meret", "cikkszam", "feszultseg", "teljesitmeny",
  "nyomatek", "fordulatszam", "atmero", "hossz", "szelesseg",
  // question words that themselves ask for a spec
  "milyen", "melyik", "mekkora", "mennyi", "hany", "mely",
];

// Questions that LOOK like part+spec but are really frequency statistics,
// requisitions, or spare-motor stock must NOT be captured by part_spec.
const PART_SPEC_GUARD_WORDS: string[] = [
  // hu (folded) — prefix-matched
  "legtobbszor", "legtobb", "leggyakoribb", "leggyakorubi", "leggyakorib",
  "legjellemzobb", "leggyakrabban", "gyakori", "gyakran", "rendelt",
  "rendelunk", "rendeltunk", "rendeltek", "megrendelt", "rendeles",
  "zarlatos", "raktar", "potmotor", "tartalek",
  // en (folded) — prefix-matched
  "most common", "most often", "how often", "frequently", "ordered",
  "ordering", "order", "stock",
];

const PART_SPEC_MIN = 4;

function isPartSpecQuestion(text: string): boolean {
  const n = norm(text);
  const flat = n.replace(/'/g, "");
  for (const g of PART_SPEC_GUARD_WORDS) {
    if (flat.includes(g)) return false;
  }
  const tokens = flat.split(/[^a-z0-9]+/).filter((t) => t.length >= PART_SPEC_MIN);
  let part = false;
  let spec = false;
  for (const tok of tokens) {
    if (!part) {
      for (const w of PART_SPEC_WORDS) {
        if (tok.startsWith(w.slice(0, PART_SPEC_MIN))) { part = true; break; }
      }
    }
    if (!spec) {
      for (const sw of PART_SPEC_SPEC_WORDS) {
        if (tok.startsWith(sw.slice(0, PART_SPEC_MIN))) { spec = true; break; }
      }
    }
    if (part && spec) break;
  }
  return part && spec;
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
  problem_solution: ["Show the related tickets", "Which customer had this before?"],
  part_spec: ["Show the related work orders", "Which customer had this replacement before?"],
  problem_solution: ["Show the related tickets", "Which customer had this before?"],
  part_spec: ["Show the related work orders", "Which customer had this replacement before?"],
  find_related: ["Show me the full timeline", "Are there any open tickets for this machine?"],
  needs_clarification: ["Which customer do we visit most?", "Show me the TMV-400 tickets", "How many critical tickets are open now?"],
};

function fu(language: "hu" | "en", intent: RouteIntent, hu: string[]): string[] {
  if (language === "hu") return hu;
  return EN_FOLLOWUP_BY_INTENT[intent] ?? hu.map((h) => h); // best-effort fallback
}

/**
 * Make follow-up chips context-carrying. The router's follow-ups are
 * static ("Mi a leggyakoribb hibája?") — when the user clicks one, the
 * new question loses the entity the previous answer was about, so the
 * router can't scope it ("0 találat" or wrong intent). This appends the
 * entity so "Mi a leggyakoribb hibája?" becomes "Mi a leggyakoribb
 * hibája az M26057 gépen?" for a device-scoped plan.
 *
 * Only appends when the follow-up doesn't already mention the entity.
 */
export function contextualizeFollowUps(plan: RoutePlan, language: "hu" | "en"): string[] {
  const fups = plan.follow_ups ?? [];
  const device = plan.filters.device;
  const sorszam = plan.filters.sorszam;
  const customer = plan.filters.customer;
  if (!device && !sorszam && !customer) return fups;

  let suffix: string;
  if (device) {
    suffix = language === "hu"
      ? ` ${huDefiniteArticle(device)} ${device} gépen`   // M-serial reads "em-..." → az
      : ` on the ${device} machine`;
  } else if (sorszam) {
    suffix = language === "hu"
      ? ` ${huDefiniteArticle(sorszam)} ${sorszam} munkánál`
      : ` for work order ${sorszam}`;
  } else {
    suffix = language === "hu"
      ? ` ${huDefiniteArticle(customer)} ${customer} ügyfélnél`
      : ` for ${customer}`;
  }

  return fups.map((f) => {
    const folded = f.toLowerCase();
    const entity = (device ?? sorszam ?? customer ?? "").toLowerCase();
    if (entity && folded.includes(entity)) return f; // already contextualized
    // Move a trailing question mark to the end so the result reads
    // "Mi a leggyakoribb hibája az M26057 gépen?" not
    // "Mi a leggyakoribb hibája? az M26057 gépen".
    const base = f.trim().replace(/[?？]+$/, "");
    const punct = base.length < f.trim().length ? "?" : "";
    return `${base}${suffix}${punct}`;
  });
}

/**
 * Make follow-up chips context-carrying. The router's follow-ups are
 * static ("Mi a leggyakoribb hibája?") — when the user clicks one, the
 * new question loses the entity the previous answer was about, so the
 * router can't scope it ("0 találat" or wrong intent). This appends the
 * entity so "Mi a leggyakoribb hibája?" becomes "Mi a leggyakoribb
 * hibája az M26057 gépen?" for a device-scoped plan.
 *
 * Only appends when the follow-up doesn't already mention the entity.
 */
export function contextualizeFollowUps(plan: RoutePlan, language: "hu" | "en"): string[] {
  const fups = plan.follow_ups ?? [];
  const device = plan.filters.device;
  const sorszam = plan.filters.sorszam;
  const customer = plan.filters.customer;
  if (!device && !sorszam && !customer) return fups;

  let suffix: string;
  if (device) {
    suffix = language === "hu"
      ? ` ${huDefiniteArticle(device)} ${device} gépen`   // M-serial reads "em-..." → az
      : ` on the ${device} machine`;
  } else if (sorszam) {
    suffix = language === "hu"
      ? ` ${huDefiniteArticle(sorszam)} ${sorszam} munkánál`
      : ` for work order ${sorszam}`;
  } else {
    suffix = language === "hu"
      ? ` ${huDefiniteArticle(customer)} ${customer} ügyfélnél`
      : ` for ${customer}`;
  }

  return fups.map((f) => {
    const folded = f.toLowerCase();
    const entity = (device ?? sorszam ?? customer ?? "").toLowerCase();
    if (entity && folded.includes(entity)) return f; // already contextualized
    // Move a trailing question mark to the end so the result reads
    // "Mi a leggyakoribb hibája az M26057 gépen?" not
    // "Mi a leggyakoribb hibája? az M26057 gépen".
    const base = f.trim().replace(/[?？]+$/, "");
    const punct = base.length < f.trim().length ? "?" : "";
    return `${base}${suffix}${punct}`;
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function routeQuestionCore(q: string, language: "hu" | "en" = "hu"): RoutePlan {
function routeQuestionCore(q: string, language: "hu" | "en" = "hu"): RoutePlan {
  const text = (q ?? "").trim();
  const n = norm(text);
  const period = detectPeriod(text);
  const customer = extractCustomer(text);
  // Phase 6: also try a "weak" customer match (bare ALL-CAPS phrase
  // with no legal suffix). The answer handler (answer.ts) probes the
  // customers table before honoring the filter.
  const weakCustomer = customer ? undefined : extractWeakCustomer(text);
  const device = extractDevice(text);
  const sorszam = extractSorszam(text);
  const topN = extractTopN(text);

  const f: RouteFilter = {};
  if (customer) f.customer = customer;
  else if (weakCustomer) f.customer = weakCustomer;
  if (device) f.device = device;
  if (sorszam) f.sorszam = sorszam;
  // For gating customer_* branches: either a strong or weak match counts.
  const customerOrWeak = customer ?? weakCustomer;

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

  // ---- Part-spec questions ("X tengely golyósorsó csapágyak típusa és
  // mennyisége, M09192 munkánál") ----
  // The old behavior routed these to a device ticket list and answered
  // with a hit counter ("50 találat minden idők. Az első sorszám:
  // B26061810.") even though the spec sits in a work note (B25082210:
  // "X tengely golyósorsó csapágyak cseréje 4 db 30TAC62CSUHPN7C").
  // Must come before the sorszam lookup (a part question scoped to a
  // work order is still a spec question) and before the device branch.
  if (isPartSpecQuestion(text)) {
    const leftover = leftoverProse(text, f);
    const leftoverTokens = leftover ? leftover.split(/\s+/).filter((t) => t.length >= 2) : [];
    const partQ = leftoverTokens.length >= 2 ? leftover : undefined;
    return {
      intent: "part_spec",
      primitive: "search_tickets",
      filters: { ...f, ...(partQ ? { q: partQ } : {}) },
      period,
      limit: 20,
      order: "recent_desc",
      follow_ups: fu(language, "part_spec", [
        "Mutasd a kapcsolódó jegyeket",
        "Melyik ügyfélnél fordult elő ugyanez a csere?",
      ]),
      rationale: "part-spec question -> extract type/quantity from notes",
    };
  }

  // ---- Part-spec questions ("X tengely golyósorsó csapágyak típusa és
  // mennyisége, M09192 munkánál") ----
  // The old behavior routed these to a device ticket list and answered
  // with a hit counter ("50 találat minden idők. Az első sorszám:
  // B26061810.") even though the spec sits in a work note (B25082210:
  // "X tengely golyósorsó csapágyak cseréje 4 db 30TAC62CSUHPN7C").
  // Must come before the sorszam lookup (a part question scoped to a
  // work order is still a spec question) and before the device branch.
  if (isPartSpecQuestion(text)) {
    const leftover = leftoverProse(text, f);
    const leftoverTokens = leftover ? leftover.split(/\s+/).filter((t) => t.length >= 2) : [];
    const partQ = leftoverTokens.length >= 2 ? leftover : undefined;
    return {
      intent: "part_spec",
      primitive: "search_tickets",
      filters: { ...f, ...(partQ ? { q: partQ } : {}) },
      period,
      limit: 20,
      order: "recent_desc",
      follow_ups: fu(language, "part_spec", [
        "Mutasd a kapcsolódó jegyeket",
        "Melyik ügyfélnél fordult elő ugyanez a csere?",
      ]),
      rationale: "part-spec question -> extract type/quantity from notes",
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
      filters: { sorszam, ...(szQ ? { q: szQ } : {}) },
      follow_ups: fu(language, "search_tickets", [
        "Mik a legutóbbi ticketjeik?",
        "Milyen kategóriájú hibák jellemzőek erre az ügyfélre?",
      ]),
      rationale: "explicit sorszam -> direct lookup",
    };
  }

  // ---- Problem -> solution ("hogyan tudom megjavítani?" / symptom) ----
  // The most important real-world question type: the user describes a
  // symptom ("elsötétült az NCT 204 kijelzője") and asks how to fix it
  // — or just states the symptom without a request phrase. The old
  // behavior dropped the problem prose (Phase 5.6 keeps q only
  // as descriptive context) and returned a bare hit counter. Here we
  // KEEP the problem prose as q (with the request words stripped) so
  // buildSummary can match it against historical fixes and answer with
  // what was done before. Must come BEFORE the device branch so a
  // device + "hogyan javítsam" / device + symptom statement doesn't
  // fall through to a plain ticket list.
  //
  // Two triggers:
  //  1) request phrase: "hogyan tudom megjavítani?", "how do i fix"...
  //  2) symptom statement (no request phrase): "Elsötétült az NCT 204
  //     kijelzője" — requires an identifier (device/sorszam/customer)
  //     so free-text search questions stay search, and skips
  //     question-word forms ("Mi a leggyakoribb hibája...?") and list
  //     requests ("Mutasd a ... ticketjeit").
  const leftover = leftoverProse(text, f);
  const hasIdentifier = !!(f.device || f.sorszam || f.customer);
  const requestTrigger = has(
    text,
    // hu
    "hogyan tudom", "hogyan lehet", "hogyan javítsam", "hogyan javitsam", "hogyan kell",
    "hogyan oldjam", "hogyan oldom", "hogyan tudnám", "hogyan tudnam", "hogyan cseréljem",
    "hogyan csereljem", "hogyan cseréljük", "hogyan csereljuk", "hogyan állítsam",
    "hogyan allitsam", "mit tegyek", "mit csináljak", "mit tegyünk", "mit csináljunk",
    "mit javasolsz", "mit javasoltok", "meg tudom javítani", "meg tudom javitani",
    "meg lehet javítani", "meg lehet javitani", "lehet-e javítani", "lehet e javitani",
    "megjavítani", "megjavitani",
    "javítási tipp", "javitasi tipp", "tanács", "tanacs", "megoldás", "megoldas",
    "hogyan szereljem", "hogyan szereljuk",
    // en
    "how do i fix", "how can i fix", "how to fix", "how do i repair", "how to repair",
    "how would you fix", "how do you fix", "what can i do", "what should i do",
    "solution for", "best way to fix", "fix this", "how do i solve", "how to solve",
    "any idea how",
  );
  const statementTrigger =
    hasIdentifier && !isQuestionLeader(text) && hasSymptom(norm(leftover ?? ""));
  if (requestTrigger || statementTrigger) {
    // The problem prose = the question minus the request words. The
    // trigger words are request boilerplate ("hogyan", "tudom",
    // "megjavítani"), not part of the symptom — strip them so the
    // remaining tokens ("elsötétült kijelzője") are matchable against
    // historical fault/work notes.
    const PROB_STOP = new Set([
      "hogyan", "tudom", "tudnám", "tudnam", "tud", "lehet", "kell", "meg", "mit", "hogy",
      "megjavítani", "megjavitani", "javítsam", "javitsam", "javítani", "javitani",
      "megoldani", "megoldás", "megoldas", "tegyek", "tegyünk", "csináljak", "csináljunk",
      "tanács", "tanacs", "tipp", "javasolsz", "javasoltok", "cseréljem", "csereljem",
      "cseréljük", "csereljuk", "állítsam", "allitsam", "oldjam", "oldom", "szereljem",
      "szereljuk", "kérem", "kerem", "kérlek", "kerlek", "szeretném", "szeretnem", "ezt",
      "azt", "nekem", "neki", "ez", "az", "a", "van", "hogyan kell", "megjavítani",
      // generic machine words — "Hogyan javítsam meg a gépet?" leaves
      // nothing meaningful to match against
      "gép", "gep", "gépet", "gepet", "gépem", "gepem", "gépek", "gepek",
      // en
      "how", "do", "i", "can", "to", "fix", "repair", "solve", "solution", "would", "you",
      "what", "should", "me", "this", "the", "best", "way", "for", "any", "idea", "we",
      "please", "help",
    ]);
    // Keep the ORIGINAL (accented) words whose folded form passes the
    // filter, so the answer displays "elsötétült kijelzője" instead of
    // "elsotetult kijelzoje". Matching folds again in buildSummary.
    const probWords = (leftover ?? "")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .filter((w) => {
        const fw = w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return !PROB_STOP.has(w.toLowerCase()) && !PROB_STOP.has(fw);
      });
    const probQ = probWords.join(" ");
    return {
      intent: "problem_solution",
      primitive: "search_tickets",
      filters: { ...f, ...(probQ ? { q: probQ } : {}) },
      period,
      limit: 20,
      order: "recent_desc",
      follow_ups: fu(language, "problem_solution", [
        "Mutasd a kapcsolódó ticketeket",
        "Melyik ügyfélnél fordult elő?",
      ]),
      rationale: "problem-solution question -> match historical fixes",
    };
  }

  // ---- Problem -> solution ("hogyan tudom megjavítani?" / symptom) ----
  // The most important real-world question type: the user describes a
  // symptom ("elsötétült az NCT 204 kijelzője") and asks how to fix it
  // — or just states the symptom without a request phrase. The old
  // behavior dropped the problem prose (Phase 5.6 keeps q only
  // as descriptive context) and returned a bare hit counter. Here we
  // KEEP the problem prose as q (with the request words stripped) so
  // buildSummary can match it against historical fixes and answer with
  // what was done before. Must come BEFORE the device branch so a
  // device + "hogyan javítsam" / device + symptom statement doesn't
  // fall through to a plain ticket list.
  //
  // Two triggers:
  //  1) request phrase: "hogyan tudom megjavítani?", "how do i fix"...
  //  2) symptom statement (no request phrase): "Elsötétült az NCT 204
  //     kijelzője" — requires an identifier (device/sorszam/customer)
  //     so free-text search questions stay search, and skips
  //     question-word forms ("Mi a leggyakoribb hibája...?") and list
  //     requests ("Mutasd a ... ticketjeit").
  const leftover = leftoverProse(text, f);
  const hasIdentifier = !!(f.device || f.sorszam || f.customer);
  const requestTrigger = has(
    text,
    // hu
    "hogyan tudom", "hogyan lehet", "hogyan javítsam", "hogyan javitsam", "hogyan kell",
    "hogyan oldjam", "hogyan oldom", "hogyan tudnám", "hogyan tudnam", "hogyan cseréljem",
    "hogyan csereljem", "hogyan cseréljük", "hogyan csereljuk", "hogyan állítsam",
    "hogyan allitsam", "mit tegyek", "mit csináljak", "mit tegyünk", "mit csináljunk",
    "mit javasolsz", "mit javasoltok", "meg tudom javítani", "meg tudom javitani",
    "meg lehet javítani", "meg lehet javitani", "lehet-e javítani", "lehet e javitani",
    "megjavítani", "megjavitani",
    "javítási tipp", "javitasi tipp", "tanács", "tanacs", "megoldás", "megoldas",
    "hogyan szereljem", "hogyan szereljuk",
    // en
    "how do i fix", "how can i fix", "how to fix", "how do i repair", "how to repair",
    "how would you fix", "how do you fix", "what can i do", "what should i do",
    "solution for", "best way to fix", "fix this", "how do i solve", "how to solve",
    "any idea how",
  );
  const statementTrigger =
    hasIdentifier && !isQuestionLeader(text) && hasSymptom(norm(leftover ?? ""));
  if (requestTrigger || statementTrigger) {
    // The problem prose = the question minus the request words. The
    // trigger words are request boilerplate ("hogyan", "tudom",
    // "megjavítani"), not part of the symptom — strip them so the
    // remaining tokens ("elsötétült kijelzője") are matchable against
    // historical fault/work notes.
    const PROB_STOP = new Set([
      "hogyan", "tudom", "tudnám", "tudnam", "tud", "lehet", "kell", "meg", "mit", "hogy",
      "megjavítani", "megjavitani", "javítsam", "javitsam", "javítani", "javitani",
      "megoldani", "megoldás", "megoldas", "tegyek", "tegyünk", "csináljak", "csináljunk",
      "tanács", "tanacs", "tipp", "javasolsz", "javasoltok", "cseréljem", "csereljem",
      "cseréljük", "csereljuk", "állítsam", "allitsam", "oldjam", "oldom", "szereljem",
      "szereljuk", "kérem", "kerem", "kérlek", "kerlek", "szeretném", "szeretnem", "ezt",
      "azt", "nekem", "neki", "ez", "az", "a", "van", "hogyan kell", "megjavítani",
      // generic machine words — "Hogyan javítsam meg a gépet?" leaves
      // nothing meaningful to match against
      "gép", "gep", "gépet", "gepet", "gépem", "gepem", "gépek", "gepek",
      // en
      "how", "do", "i", "can", "to", "fix", "repair", "solve", "solution", "would", "you",
      "what", "should", "me", "this", "the", "best", "way", "for", "any", "idea", "we",
      "please", "help",
    ]);
    // Keep the ORIGINAL (accented) words whose folded form passes the
    // filter, so the answer displays "elsötétült kijelzője" instead of
    // "elsotetult kijelzoje". Matching folds again in buildSummary.
    const probWords = (leftover ?? "")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .filter((w) => {
        const fw = w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return !PROB_STOP.has(w.toLowerCase()) && !PROB_STOP.has(fw);
      });
    const probQ = probWords.join(" ");
    return {
      intent: "problem_solution",
      primitive: "search_tickets",
      filters: { ...f, ...(probQ ? { q: probQ } : {}) },
      period,
      limit: 20,
      order: "recent_desc",
      follow_ups: fu(language, "problem_solution", [
        "Mutasd a kapcsolódó ticketeket",
        "Melyik ügyfélnél fordult elő?",
      ]),
      rationale: "problem-solution question -> match historical fixes",
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
  if (
    // "hub" must be a whole word — a bare substring would also fire on
    // garbage like "Hubbbubbbla" and route nonsense to top_hubs. The
    // phrase needles below still cover "hub ticket" explicitly.
    /\bhub\b/.test(norm(text)) ||
    has(text, "melyik munkahoz", "melyik munkához", "melyik munka", "legnagyobb munka", "legtobb kiszallas ehhez", "legtöbb kiszállás ehhez", "fo munkarend", "fő munkarend", "centralis munka", "centrális munka", "legtobb alkalommal", "legtöbb alkalommal", "melyik ticketre", "which work order", "which job had the most", "central case", "hub ticket")
  ) {
  if (
    // "hub" must be a whole word — a bare substring would also fire on
    // garbage like "Hubbbubbbla" and route nonsense to top_hubs. The
    // phrase needles below still cover "hub ticket" explicitly.
    /\bhub\b/.test(norm(text)) ||
    has(text, "melyik munkahoz", "melyik munkához", "melyik munka", "legnagyobb munka", "legtobb kiszallas ehhez", "legtöbb kiszállás ehhez", "fo munkarend", "fő munkarend", "centralis munka", "centrális munka", "legtobb alkalommal", "legtöbb alkalommal", "melyik ticketre", "which work order", "which job had the most", "central case", "hub ticket")
  ) {
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

  // Device-scoped customer drill-down: "Melyik ügyfélnél van a legtöbb
  // az M17191 gépen?" (a follow-up chip) must answer for THAT device,
  // not the global top-customers list. Requires a specific device serial
  // and NO extracted customer — customer+device questions keep their own
  // branches above. `f` carries the device, so the stats executor scopes
  // the group_by customer counts to the machine.
  if (device && !customer && has(text, "ugyfel", "ügyfél", "customer", "ceg", "cég", "kinek járunk", "kihez járunk", "kihez jarunk", "kinek megyunk", "kinek megyünk", "legtobb kiszallas", "legtöbb kiszállás", "kinek szolgaltatunk")) {
    return {
      intent: "device_top_customers",
      primitive: "stats",
      group_by: "customer",
      filters: f,
      period,
      limit: topN ?? 5,
      order: "count_desc",
      follow_ups: fu(language, "search_tickets", [
        "Mutasd a legutóbbi ticketjeit",
        "Mi a leggyakoribb hibája?",
      ]),
      rationale: "device top customers",
    };
  }


  // Device-scoped customer drill-down: "Melyik ügyfélnél van a legtöbb
  // az M17191 gépen?" (a follow-up chip) must answer for THAT device,
  // not the global top-customers list. Requires a specific device serial
  // and NO extracted customer — customer+device questions keep their own
  // branches above. `f` carries the device, so the stats executor scopes
  // the group_by customer counts to the machine.
  if (device && !customer && has(text, "ugyfel", "ügyfél", "customer", "ceg", "cég", "kinek járunk", "kihez járunk", "kihez jarunk", "kinek megyunk", "kinek megyünk", "legtobb kiszallas", "legtöbb kiszállás", "kinek szolgaltatunk")) {
    return {
      intent: "device_top_customers",
      primitive: "stats",
      group_by: "customer",
      filters: f,
      period,
      limit: topN ?? 5,
      order: "count_desc",
      follow_ups: fu(language, "search_tickets", [
        "Mutasd a legutóbbi ticketjeit",
        "Mi a leggyakoribb hibája?",
      ]),
      rationale: "device top customers",
    };
  }

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
        "Melyik ügyfélhez milyen gépeket szervizelünk?",
      ]),
      rationale: "top customers",
    };
  }

  if (
    has(text, "gep tipus", "gép típus", "machine type", "geptipus", "leggyakoribb gephiba", "leggyakoribb géphiba", "melyik gep megy", "melyik gép megy", "melyik gep tonkre", "melyik gép tönkre", "which machine", "what machine", "melyik gep hibasodik", "melyik gép hibásodik", "melyik gep hibasod", "melyik gép hibásod", "which machine breaks", "which machine fails", "which machine has the most") ||
      // Frequency + machine without the exact "melyik gep megy/tonkre"
      // phrasing ("Melyik gép hibásodik meg a legtöbbször?"). The
      // !device guard keeps device-scoped questions ("… az M26057
      // gépen?") on the device drill-down branch below.
      (has(text, "gep", "gép", "machine") && has(text, "legtobbszor", "legtöbbször", "leggyakrabban") && !device)
  ) {
  if (
    has(text, "gep tipus", "gép típus", "machine type", "geptipus", "leggyakoribb gephiba", "leggyakoribb géphiba", "melyik gep megy", "melyik gép megy", "melyik gep tonkre", "melyik gép tönkre", "which machine", "what machine", "melyik gep hibasodik", "melyik gép hibásodik", "melyik gep hibasod", "melyik gép hibásod", "which machine breaks", "which machine fails", "which machine has the most") ||
      // Frequency + machine without the exact "melyik gep megy/tonkre"
      // phrasing ("Melyik gép hibásodik meg a legtöbbször?"). The
      // !device guard keeps device-scoped questions ("… az M26057
      // gépen?") on the device drill-down branch below.
      (has(text, "gep", "gép", "machine") && has(text, "legtobbszor", "legtöbbször", "leggyakrabban") && !device)
  ) {
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
  // Phase 6: gates on either a strong customer match (Kft./-nél/English
  // for/at) OR a weak one (bare ALL-CAPS phrase). The answer handler
  // (answer.ts) probes the customers table for the weak case; if 0
  // customers match, the filter is dropped and the question falls
  // through to the device / free-text branch.
  if (customerOrWeak && !has(text, "legjobb", "legtobb", "legkevesebb", "top")) {
    if (has(text, "kritikus", "kritical")) {
      return {
        intent: "customer_open_count",
        primitive: "search_tickets",
        filters: { customer: customerOrWeak, sulyossag_inferred: "kritikus" },
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
        filters: { customer: customerOrWeak },
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
        filters: { customer: customerOrWeak },
        period,
        limit: 10,
        order: "count_desc",
        follow_ups: fu(language, "top_kategoriak_inferred", [
          "Mutasd a szoftver hibáikat",
          "Melyik technikus szervizeli őket?",
        ]),
        rationale: "customer top kategoria",
      };
    }
    if (has(text, "utoljara", "utoljára", "utolso", "utolsó", "last", "when")) {
      return {
        intent: "customer_last_seen",
        primitive: "search_tickets",
        filters: { customer: customerOrWeak },
        period,
        limit: 1,
        order: "recent_desc",
        follow_ups: fu(language, "search_tickets", [
          "Mutasd az utolsó 5 ticketjüket",
          "Milyen gépeket szervizelünk náluk?",
        ]),
        rationale: "customer last_seen",
      };
    }
    if (has(text, "technikus", "ki szervizel", "ki szervizel")) {
      return {
        intent: "customer_top_technicians",
        primitive: "stats",
        group_by: "technician",
        filters: { customer: customerOrWeak },
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
      filters: { customer: customerOrWeak },
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
    // "leggyakorubi"/"leggyakorib" are the user's habitual typos of
    // "leggyakoribb" — accept them so the follow-up still routes to
    // device_top_problem instead of falling through to a plain list.
    if (has(text, "leggyakoribb", "leggyakorubi", "leggyakorib", "legjellemzőbb", "mi a baja", "mi a hibaja", "most common", "what's wrong")) {
      return {
        intent: "device_top_problem",
        primitive: "stats",
        group_by: "kategoria_inferred",
        filters: { device, ...(devQ ? { q: devQ } : {}) },
        // No period default on purpose: "Mi a leggyakoribb hibája az
        // M26057 gépen?" means the machine's most common fault across
        // its whole history. Defaulting to last_year returns "0 találat
        // tavaly" whenever the machine simply had no service last year.
        period,
        limit: 5,
        order: "count_desc",
        follow_ups: fu(language, "search_tickets", [
          "Mutasd a legutóbbi ticketjeit",
          "Melyik ügyfélnél a leggyakoribb?",
          "Melyik ügyfélnél a leggyakoribb?",
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
        "Melyik ügyfélnél a leggyakoribb?",
        "Melyik ügyfélnél a leggyakoribb?",
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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
// `routeQuestionCore` decides intent/primitive/filters; this wrapper then
// overlays the explicit-date detection. When the question names concrete
// dates ("napjainktól 2024.05.10-ig visszamenőleg", "2024.01.01-től
// 2024.12.31-ig", "from 2024-05-10 to 2024-06-01", "until 2024-05-10"),
// the plan's period becomes "custom" and the dates ride on
// date_from/date_to so executePlan can pass them verbatim to
// resolvePeriod (and the search/stats primitives filter on them).
// Explicit dates win over named periods — a question can't be both
// "az utolsó 30 napban" and "2024.05.10-től", and the user's explicit
// window must never be silently downgraded to "minden idők".
export function routeQuestion(q: string, language: "hu" | "en" = "hu"): RoutePlan {
  const plan = routeQuestionCore(q, language);
  const dates = detectExplicitDates(q);
  if (dates) {
    plan.period = "custom";
    plan.date_from = dates.date_from;
    plan.date_to = dates.date_to;
  }
  // Phase 6: if the customer filter was set by the WEAK extractor
  // (bare ALL-CAPS phrase, no legal suffix), tag the plan so the
  // answer handler can run a `search_customers` DB probe before
  // honoring the filter. The router is pure (no DB access), so it
  // cannot validate the match itself; the probe is ~5-15ms.
  if (
    plan.filters.customer &&
    !plan.weak_customer &&
    isWeakCustomerMatch(plan.filters.customer)
  ) {
    plan.weak_customer = plan.filters.customer;
  }
  return plan;
}

/**
 * Phase 6: heuristic to determine if a customer string was extracted
 * by the WEAK (4th) pattern. We don't store this on the plan during
 * routeQuestionCore because the customer-drill-down branches build
 * their plans via fresh `{ customer }` objects. So the public
 * `routeQuestion()` re-checks the string against the same rules.
 *
 * Returns true when:
 *   - the customer contains NO legal suffix (Kft./Zrt./Bt./Rt./Nyrt./Kkt.)
 *   - the customer does NOT end in -nál/-nél/-nal/-nel
 *   - the customer is not preceded by "for" / "at" (English)
 *   - the customer has 1-3 space-separated tokens, all starting with a
 *     capital letter, no digits (so it can't be a machine serial)
 */
function isWeakCustomerMatch(customer: string): boolean {
  if (!customer) return false;
  // If it has a legal suffix, it's a strong (Kft./Zrt./…) match.
  if (/\b(?:Kft|Bt|Zrt|Rt|Nyrt|Kkt)\.?\b/i.test(customer)) return false;
  // If it ends in -nál/-nél, it's a strong match.
  if (/(?:nál|nél|nal|nel)\b/i.test(customer)) return false;
  // If it's a known Hungarian/English question word, not a customer.
  if (customer.length < 3) return false;
  // If it has a digit, it's likely a model code / serial (e.g. "TMV-400").
  if (/\d/.test(customer)) return false;
  // The customer must have 1-3 tokens, all starting with a capital.
  const tokens = customer.trim().split(/\s+/);
  if (tokens.length < 1 || tokens.length > 3) return false;
  if (!tokens.every((t) => /^[A-ZÁÉÍÓÖŐÚÜŰ]/.test(t))) return false;
  // English: starts with "for " or "at " would have been a strong match.
  return true;
}

// ---------------------------------------------------------------------------
// v2 toolset curation — the bridge between the deterministic router and the
// v2 agent. Maps a RoutePlan to a minimal 2-4 tool surface + a tailored
// "tool assignment" string the model sees as its only option.
//
// The point: the model NEVER sees 8 tools. It sees the 2-4 that actually
// make sense for THIS question, picked by the router. The schemas it sees
// are minimal (no optional filter fields it could hallucinate). The
// primary primitive is the one the router already chose; the others are
// siblings the LLM can reach for if the primary returns empty.
//
// Returns:
//   - `tools`: ordered list of tool names for `buildAgentToolsV2` to filter
//   - `assignment`: a short hu/en prompt sentence the LLM sees as its
//     task description ("For 'M26057 vezérlés', use get_device_history
//     first; if it returns 0, fall back to search_tickets.").
//   - `suggestedArgs`: ready-made tool-call arguments for the primary
//     tool, derived from the router's extracted fields. The LLM can
//     accept or override.
// ---------------------------------------------------------------------------

export type V2ToolAssignment = {
  tools: string[];        // ordered list of tool names
  primary: string;        // the first tool — try this first
  fallbacks: string[];    // the rest — try if primary returned 0/404
  assignment: string;     // prompt sentence (hu/en)
  suggestedArgs: Record<string, Record<string, unknown>>; // tool name -> args
};

const TOOL_OF_PRIMITIVE: Record<RoutePrimitive, string> = {
  search_tickets: "search_tickets",
  stats: "get_ticket_stats",
  find_ticket_by_sorszam: "find_ticket",
  find_recurring_problems: "search_tickets", // v2 surfaces the result via search_tickets
  find_related_tickets: "find_related_tickets",
  top_hubs: "find_linkage",
  search_serviz_archive: "search_tickets",   // v2 doesn't have a serviz-specific tool; route through search_tickets
  search_szev_igeny: "search_tickets",
  search_telephely_munka: "search_tickets",
  find_spare_motor: "find_spare_motor",
  get_failure_rates: "get_ticket_stats",     // stats surface covers this
  get_categories: "search_tickets",         // categories are static — answer from memory
  get_tags: "search_tickets",               // tags are static — answer from memory
  search_ais_motor_inventory: "search_tickets", // v2 doesn't have a dedicated tool; fall through to search
};

export function curateV2Toolset(plan: RoutePlan, question: string, language: "hu" | "en" = "hu"): V2ToolAssignment {
  const sorszam = plan.filters.sorszam;
  const device = plan.filters.device;
  const customer = plan.filters.customer;

  // Pick the PRIMARY tool based on the EXTRACTED FIELDS, not just the
  // primitive. The router's primitive points at the legacy /v1/answer
  // surface; the v2 surface is intent-and-fields-driven.
  let primary: string;
  const fallbacks: string[] = [];

  if (plan.intent === "find_ticket_by_sorszam" && sorszam) {
    primary = "find_ticket";
    if (!fallbacks.includes("find_related_tickets")) fallbacks.push("find_related_tickets");
    if (!fallbacks.includes("search_tickets")) fallbacks.push("search_tickets");
  } else if (plan.intent === "find_related") {
    primary = "find_related_tickets";
    if (!fallbacks.includes("find_ticket")) fallbacks.push("find_ticket");
    if (!fallbacks.includes("search_tickets")) fallbacks.push("search_tickets");
  } else if (plan.intent === "top_hubs") {
    primary = "find_linkage";
    if (!fallbacks.includes("search_tickets")) fallbacks.push("search_tickets");
  } else if (
    plan.primitive === "stats" ||
    plan.intent.startsWith("top_") ||
    plan.intent.startsWith("count_") ||
    plan.intent.startsWith("customer_")
  ) {
    primary = "get_ticket_stats";
    if (device && !fallbacks.includes("get_device_history")) fallbacks.push("get_device_history");
    if (customer && !fallbacks.includes("list_customers")) fallbacks.push("list_customers");
    if (!fallbacks.includes("search_tickets")) fallbacks.push("search_tickets");
  } else if (plan.intent === "find_spare_motor") {
    primary = "find_spare_motor";
    if (!fallbacks.includes("search_tickets")) fallbacks.push("search_tickets");
  } else if (device) {
    // Any question with a device hint: get_device_history is the best
    // primary (returns all rows for the device; the LLM synthesizes
    // the timeline / fault pattern from raw data).
    primary = "get_device_history";
    if (!fallbacks.includes("find_related_tickets")) fallbacks.push("find_related_tickets");
    if (!fallbacks.includes("search_tickets")) fallbacks.push("search_tickets");
  } else if (customer) {
    primary = "get_ticket_stats";
    if (!fallbacks.includes("list_customers")) fallbacks.push("list_customers");
    if (!fallbacks.includes("search_tickets")) fallbacks.push("search_tickets");
  } else {
    primary = "search_tickets";
    if (!fallbacks.includes("get_ticket_stats")) fallbacks.push("get_ticket_stats");
  }

  const tools = Array.from(new Set([primary, ...fallbacks])).slice(0, 4);

  // Build suggested args for the primary tool. The LLM can use these
  // verbatim, or override; but it doesn't have to INVENT them.
  const suggestedArgs: Record<string, Record<string, unknown>> = {};

  if (primary === "find_ticket") {
    suggestedArgs.find_ticket = { sorszam: sorszam ?? question, language };
  } else if (primary === "get_device_history") {
    if (device) suggestedArgs.get_device_history = { device, limit: 50, language };
  } else if (primary === "search_tickets") {
    suggestedArgs.search_tickets = { q: question, include_evidence: true, language };
  } else if (primary === "get_ticket_stats") {
    const group_by = plan.group_by ?? (customer ? "customer" : device ? "device" : "customer");
    suggestedArgs.get_ticket_stats = { group_by, language, include_evidence: true };
  } else if (primary === "find_related_tickets") {
    suggestedArgs.find_related_tickets = {
      ...(sorszam ? { sorszam } : {}),
      ...(device ? { device } : {}),
      ...(customer ? { customer } : {}),
      language,
      limit: 50,
    };
  } else if (primary === "find_linkage") {
    suggestedArgs.find_linkage = { direction: "top_hubs", limit: 10 };
  } else if (primary === "find_spare_motor") {
    if (device) suggestedArgs.find_spare_motor = { serial_number: device, language, limit: 5 };
    else suggestedArgs.find_spare_motor = { problem: question, language, limit: 5 };
  } else if (primary === "list_customers") {
    suggestedArgs.list_customers = { q: customer ?? question, language, limit: 10 };
  }

  // Fallback args
  for (const fb of fallbacks) {
    if (suggestedArgs[fb]) continue;
    if (fb === "find_ticket" && sorszam) {
      suggestedArgs[fb] = { sorszam, language };
    } else if (fb === "get_device_history" && device) {
      suggestedArgs[fb] = { device, limit: 50, language };
    } else if (fb === "find_related_tickets") {
      suggestedArgs[fb] = {
        ...(sorszam ? { sorszam } : {}),
        ...(device ? { device } : {}),
        ...(customer ? { customer } : {}),
        language,
        limit: 30,
      };
    } else if (fb === "search_tickets") {
      suggestedArgs[fb] = { q: question, include_evidence: true, language };
    } else if (fb === "get_ticket_stats") {
      suggestedArgs[fb] = { group_by: plan.group_by ?? "customer", language, include_evidence: true };
    } else if (fb === "list_customers") {
      suggestedArgs[fb] = { q: customer ?? question, language, limit: 10 };
    }
  }

  const lang = language === "en" ? "en" : "hu";
  const assignment = (() => {
    if (lang === "en") {
      const sorszamNote = sorszam ? ` The user mentioned the sorszam "${sorszam}".` : "";
      const deviceNote = device ? ` The device is "${device}".` : "";
      const customerNote = customer ? ` The customer is "${customer}".` : "";
      return `This question has intent "${plan.intent}" (deterministically classified). PRIMARY tool: ${primary}.${fallbacks.length > 0 ? ` FALLBACKS (only if primary returns 0 rows or 404): ${fallbacks.join(", ")}.` : ""}${sorszamNote}${deviceNote}${customerNote} Do NOT add filter fields the user did not ask for.`;
    }
    const sorszamNote = sorszam ? ` A felhasználó sorszámot mondott: "${sorszam}".` : "";
    const deviceNote = device ? ` A gép: "${device}".` : "";
    const customerNote = customer ? ` Az ügyfél: "${customer}".` : "";
    return `Ez a kérdés intentje "${plan.intent}" (determinisztikusan osztályozva). ELSŐDLEGES eszköz: ${primary}.${fallbacks.length > 0 ? ` TARTALÉKOK (csak ha az elsődleges 0 sort vagy 404-et ad): ${fallbacks.join(", ")}.` : ""}${sorszamNote}${deviceNote}${customerNote} NE adj hozzá szűrő mezőket, amiket a felhasználó nem kért.`;
  })();

  return { tools, primary, fallbacks, assignment, suggestedArgs };
}
