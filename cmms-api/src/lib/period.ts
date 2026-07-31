// Resolve a "period" token to a concrete (date_from, date_to) ISO range.
//
// "this_month" / "this_year" / "last_30_days" / etc. are the *only* safe
// way for an LLM to ask "give me recent X" — otherwise the model has to
// compute the date itself, which fails on the first day of a month, on
// timezone confusion, and on YYYY-MM string vs YYYY-MM-DD format.
//
// Server-side date resolution also lets the response echo the exact
// window it actually used, which the LLM can cite in its answer.

export type PeriodToken =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "this_year"
  | "last_year"
  | "YTD"            // year-to-date (Jan 1 of this year to today)
  | "last_7_days"
  | "last_30_days"
  | "last_90_days"
  | "last_365_days"
  | "all"            // no date filter
  | "custom";        // use date_from / date_to verbatim

export type ResolvedPeriod = {
  /** YYYY-MM-DD inclusive, or null if "all" */
  date_from: string | null;
  /** YYYY-MM-DD inclusive, or null if "all" */
  date_to: string | null;
  /** Token that was actually used (after alias resolution) */
  resolved_token: PeriodToken;
  /** Human label for echo-back, e.g. "last 30 days" / "2025-03" */
  label_en: string;
  label_hu: string;
};

const ONE_DAY_MS = 86_400_000;

function toIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Normalize a free-form alias into a PeriodToken (or null if unknown). */
export function normalizePeriod(input: string | null | undefined): PeriodToken | null {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  // English
  const map: Record<string, PeriodToken> = {
    "today": "today",
    "yesterday": "yesterday",
    "this_week": "this_week",
    "last_week": "last_week",
    "this_month": "this_month",
    "last_month": "last_month",
    "this_quarter": "this_quarter",
    "last_quarter": "last_quarter",
    "this_year": "this_year",
    "last_year": "last_year",
    "ytd": "YTD",
    "year_to_date": "YTD",
    "year-to-date": "YTD",
    "last_7_days": "last_7_days",
    "last7days": "last_7_days",
    "last_30_days": "last_30_days",
    "last30days": "last_30_days",
    "last_90_days": "last_90_days",
    "last90days": "last_90_days",
    "last_365_days": "last_365_days",
    "last365days": "last_365_days",
    "all": "all",
    "all_time": "all",
    "ever": "all",
    "custom": "custom",
  };
  if (map[s]) return map[s];
  // Hungarian aliases — the LLM is asked questions in Hungarian, so accept
  // both the English and Hungarian spellings.
  const hu: Record<string, PeriodToken> = {
    "ma": "today",
    "tegnap": "yesterday",
    "ez_a_het": "this_week",
    "ezen_a_heten": "this_week",
    "ez a hét": "this_week",
    "ezen a héten": "this_week",
    "múlt_hét": "last_week",
    "mult_het": "last_week",
    "múlt héten": "last_week",
    "mult heten": "last_week",
    "ebben_a_honapban": "this_month",
    "ez_a_honap": "this_month",
    "ebben a hónapban": "this_month",
    "ez a hónap": "this_month",
    "múlt_hónap": "last_month",
    "mult_honap": "last_month",
    "múlt hónap": "last_month",
    "mult honap": "last_month",
    "ez_a_negyedev": "this_quarter",
    "ez_a_negyedév": "this_quarter",
    "ebben_a_negyedevben": "this_quarter",
    "ebben_a_negyedévben": "this_quarter",
    "ez a negyedév": "this_quarter",
    "ebben a negyedévben": "this_quarter",
    "múlt_negyedév": "last_quarter",
    "mult_negyedev": "last_quarter",
    "múlt negyedév": "last_quarter",
    "mult negyedev": "last_quarter",
    "ez_az_ev": "this_year",
    "idén": "this_year",
    "iden": "this_year",
    "ebben_az_evben": "this_year",
    "ebben az évben": "this_year",
    "tavaly": "last_year",
    "múlt_év": "last_year",
    "mult_ev": "last_year",
    "múlt év": "last_year",
    "mult ev": "last_year",
    "év_eleje_ota": "YTD",
    "év eleje óta": "YTD",
    "ev eleje ota": "YTD",
    "utolsó_7_nap": "last_7_days",
    "utolso_7_nap": "last_7_days",
    "utolsó 7 nap": "last_7_days",
    "utolso 7 nap": "last_7_days",
    "utolsó_30_nap": "last_30_days",
    "utolso_30_nap": "last_30_days",
    "utolsó 30 nap": "last_30_days",
    "utolso 30 nap": "last_30_days",
    "utolsó_90_nap": "last_90_days",
    "utolso_90_nap": "last_90_days",
    "utolsó 90 nap": "last_90_days",
    "utolso 90 nap": "last_90_days",
    "utolsó_év": "last_365_days",
    "utolso_ev": "last_365_days",
    "utolsó év": "last_365_days",
    "utolso ev": "last_365_days",
    "minden": "all",
    "összes": "all",
    "osszes": "all",
    "valaha": "all",
  };
  return hu[s] ?? null;
}

/**
 * Resolve a period token to concrete dates. `date_from` / `date_to` are
 * taken verbatim if the period is "custom" or if both are set explicitly
 * by the caller. `now` is injectable for tests.
 */
export function resolvePeriod(
  period: string | null | undefined,
  now: Date = new Date(),
  explicit?: { date_from?: string | null; date_to?: string | null },
): ResolvedPeriod {
  const today = startOfDay(now);
  const token = normalizePeriod(period) ?? "custom";

  if (token === "custom" || (explicit && (explicit.date_from || explicit.date_to))) {
    return {
      date_from: explicit?.date_from ?? null,
      date_to: explicit?.date_to ?? null,
      resolved_token: "custom",
      label_en: explicit?.date_from && explicit?.date_to
        ? `${explicit.date_from} → ${explicit.date_to}`
        : explicit?.date_from
          ? `from ${explicit.date_from}`
          : explicit?.date_to
            ? `until ${explicit.date_to}`
            : "no date filter",
      label_hu: explicit?.date_from && explicit?.date_to
        ? `${explicit.date_from} → ${explicit.date_to}`
        : explicit?.date_from
          ? `${explicit.date_from} -től`
          : explicit?.date_to
            ? `${explicit.date_to} -ig`
            : "nincs dátumszűrő",
    };
  }

  const labels: Record<PeriodToken, { en: string; hu: string }> = {
    today: { en: "today", hu: "ma" },
    yesterday: { en: "yesterday", hu: "tegnap" },
    this_week: { en: "this week", hu: "ez a hét" },
    last_week: { en: "last week", hu: "múlt hét" },
    this_month: { en: "this month", hu: "ez a hónap" },
    last_month: { en: "last month", hu: "múlt hónap" },
    this_quarter: { en: "this quarter", hu: "ez a negyedév" },
    last_quarter: { en: "last quarter", hu: "múlt negyedév" },
    this_year: { en: "this year", hu: "idén" },
    last_year: { en: "last year", hu: "tavaly" },
    YTD: { en: "year-to-date", hu: "év eleje óta" },
    last_7_days: { en: "last 7 days", hu: "utolsó 7 nap" },
    last_30_days: { en: "last 30 days", hu: "utolsó 30 nap" },
    last_90_days: { en: "last 90 days", hu: "utolsó 90 nap" },
    last_365_days: { en: "last 365 days", hu: "utolsó év" },
    all: { en: "all time", hu: "minden idők" },
    custom: { en: "custom", hu: "egyéni" },
  };

  const initialTo = endOfDay(today);
  let to: Date = initialTo;
  let from: Date = today;
  switch (token) {
    case "today":       from = today; break;
    case "yesterday":   from = new Date(today.getTime() - ONE_DAY_MS); to.setUTCDate(to.getUTCDate() - 1); to.setUTCHours(0,0,0,0); break;
    case "this_week": {
      // Week starts Monday (ISO).
      const dow = (today.getUTCDay() + 6) % 7; // 0 = Mon
      from = new Date(today.getTime() - dow * ONE_DAY_MS);
      break;
    }
    case "last_week": {
      const dow = (today.getUTCDay() + 6) % 7;
      const thisMon = new Date(today.getTime() - dow * ONE_DAY_MS);
      from = new Date(thisMon.getTime() - 7 * ONE_DAY_MS);
      to.setTime(thisMon.getTime() - ONE_DAY_MS);
      to.setUTCHours(23, 59, 59, 999);
      break;
    }
    case "this_month": from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)); break;
    case "last_month": {
      const firstThisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      from = new Date(Date.UTC(firstThisMonth.getUTCFullYear(), firstThisMonth.getUTCMonth() - 1, 1));
      to = new Date(firstThisMonth.getTime() - ONE_DAY_MS);
      to.setUTCHours(23, 59, 59, 999);
      break;
    }
    case "this_quarter": {
      const qStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
      from = new Date(Date.UTC(today.getUTCFullYear(), qStartMonth, 1));
      break;
    }
    case "last_quarter": {
      const qStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
      const thisQ = new Date(Date.UTC(today.getUTCFullYear(), qStartMonth, 1));
      from = new Date(Date.UTC(thisQ.getUTCFullYear(), thisQ.getUTCMonth() - 3, 1));
      to = new Date(thisQ.getTime() - ONE_DAY_MS);
      to.setUTCHours(23, 59, 59, 999);
      break;
    }
    case "this_year":  from = new Date(Date.UTC(today.getUTCFullYear(), 0, 1)); break;
    case "last_year": {
      from = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
      to = new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31, 23, 59, 59, 999));
      break;
    }
    case "YTD":        from = new Date(Date.UTC(today.getUTCFullYear(), 0, 1)); break;
    case "last_7_days":  from = new Date(today.getTime() - 6 * ONE_DAY_MS); break;
    case "last_30_days": from = new Date(today.getTime() - 29 * ONE_DAY_MS); break;
    case "last_90_days": from = new Date(today.getTime() - 89 * ONE_DAY_MS); break;
    case "last_365_days": from = new Date(today.getTime() - 364 * ONE_DAY_MS); break;
    case "all":        return { date_from: null, date_to: null, resolved_token: "all", label_en: "all time", label_hu: "minden idők" };
  }

  return {
    date_from: toIso(startOfDay(from)),
    date_to: toIso(to),
    resolved_token: token,
    label_en: labels[token].en,
    label_hu: labels[token].hu,
  };
}
