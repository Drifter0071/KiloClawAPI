// date_guard.ts
//
// Phase 5.3 — prevent the LLM from injecting date_from / date_to
// for questions that don't actually mention a date.
//
// The user-supplied case ("M17191 előéletét 2024.05.10-ig
// visszamenőleg") must still work — the LLM is just supposed to
// derive the dates from the question, not hallucinate them.
//
// Rule (see _stripLLMDates):
//   - If the LLM passes date_from / date_to AND the question (q)
//     has no detectable date mention AND no period is set, the
//     dates are stripped before forwarding to the REST API.
//   - If the LLM passes a `period` token, respect it.
//   - If the LLM passes date_from / date_to AND the question has a
//     date mention, keep the dates (this is the M17191 case).
//
// This module is in src/ so it's available to both the binary
// (cmms-api) via deploy-binary.ts and the tests. The mcp-server.ts
// inlined copy exists because deploy-mcp.ts doesn't upload src/;
// the two must stay in sync (see 20-result-guard.test.ts for the
// same pattern with result_guard.ts).

const HU_MONTHS = [
  "január", "február", "március", "április", "május", "június",
  "július", "augusztus", "szeptember", "október", "november", "december",
];
const EN_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\b/,           // 2024.05.10
  /\b\d{4}\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}\b/,      // spaced dots
  /\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/,        // 10.05.2024
  /\b\d{4}\s*[.\-]\s*\d{1,2}\b/,                   // 2024-05 (year+month)
  new RegExp(`\\b(${HU_MONTHS.join("|")})\\b`, "i"),
  new RegExp(`\\b(${EN_MONTHS.join("|")})\\b`, "i"),
  // Hungarian months often appear inflected (májusi, júniusban).
  new RegExp(`\\b(${HU_MONTHS.join("|")})`, "i"),
  /\b\d{4}\s*[-.]\s*ben\b/i,
  /\b\d{4}\s*[-.]\s*ban\b/i,
  /\b\d{4}[\u00A0\s]+(jan|feb|már|ápr|máj|jún|júl|aug|sze|okt|nov|dec)\b/i,
];

export function questionHasDate(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const re of DATE_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

export type StripResult = {
  body: Record<string, unknown> | undefined;
  stripped: boolean;
  reason?: string;
};

export function stripLLMDates(args: Record<string, unknown> | undefined): StripResult {
  if (!args) return { body: undefined, stripped: false };
  const dateFrom = (args.date_from as string | undefined)?.trim();
  const dateTo = (args.date_to as string | undefined)?.trim();
  const period = (args.period as string | undefined)?.trim();
  if (!dateFrom && !dateTo) return { body: args, stripped: false };
  // Only NAMED period tokens (today, this_year, tavaly, all, ...) earn
  // trust. period="custom" is the LLM's hand-off to its own date
  // fields — and those are the ones we're guarding against. So
  // period="custom" + dates from the LLM with no question date is
  // exactly the M09192 hallucination pattern.
  const NAMED_TOKENS = new Set([
    "today", "yesterday",
    "this_week", "last_week",
    "this_month", "last_month",
    "this_quarter", "last_quarter",
    "this_year", "last_year", "YTD",
    "last_7_days", "last_30_days", "last_90_days", "last_365_days",
    "all",
    // Hungarian aliases — accept them too.
    "ma", "tegnap", "tavaly", "iden", "idén", "múlt hónap", "ebben a hónapban",
  ]);
  if (period && NAMED_TOKENS.has(period)) return { body: args, stripped: false };
  // No recognized period (or period="custom") — guard the dates against
  // the question.
  const q = ((args.q as string | undefined) ?? "").toString();
  if (questionHasDate(q)) return { body: args, stripped: false };
  const next: Record<string, unknown> = { ...args };
  delete next.date_from;
  delete next.date_to;
  if (period === "custom") {
    // Also clear the custom period — the LLM set it as a hand-off and
    // the dates it was paired with are gone, so custom now means nothing.
    delete next.period;
  }
  return {
    body: next,
    stripped: true,
    reason: "date_from/date_to (and period='custom' if present) were dropped because the question did not mention a date and no recognized period was set. If the user wants a date range, the question must mention it (e.g. '2024.05.10-től') or the LLM must use a named period token (e.g. period='tavaly').",
  };
}
