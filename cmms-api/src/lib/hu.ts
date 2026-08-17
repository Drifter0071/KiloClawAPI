// src/lib/hu.ts
//
// Hungarian definite-article selection for the answer templates
// (Approach A of the grammar-engine design — approved by the user).
//
// Hungarian attaches "a" / "az" by PRONUNCIATION, not spelling:
//   - "az M26057"  — the serial is read letter-by-letter, "M" = "em"
//     (vowel-start) → "az".
//   - "a B25082210" — "B" = "bé" (consonant-start) → "a".
//   - "az NCT-204" — "N" = "en" → "az".
//   - a real word follows its first SOUND: "az alma", "a gép", "a fa".
//   - a digit-start token follows the digit's Hungarian name:
//     "az 1-es" (egy), "a 2-es" (kettő), "az 8-as" (nyolc).
//
// Rules here replace the old "A(z) X" hack used across the answer
// templates. Edge case (accepted): an all-caps COMPANY name that happens
// to start with a vowel-name letter (e.g. "METARAD" → M) is treated as
// an identifier and gets "az" even though "a METARAD" reads more
// naturally as a word. Company names rarely hit this in practice, and
// the identifier rule is the one the catalog actually exercises.

/** Letters whose NAME starts with a vowel → the article before an
 *  identifier starting with them is "az". */
const VOWEL_START_LETTER_NAMES = new Set([
  "A", "E", "F", "I", "L", "M", "N", "O", "R", "S", "U", "X", "Y", "Ö", "Ü",
]);

/** Article before a token whose first character is a digit, by the
 *  digit's Hungarian name: 0 nulla, 1 egy, 2 kettő, 3 három, 4 négy,
 *  5 öt, 6 hat, 7 hét, 8 nyolc, 9 kilenc. */
const DIGIT_ARTICLE: Record<string, "a" | "az"> = {
  "0": "az",
  "1": "az",
  "2": "a",
  "3": "a",
  "4": "az",
  "5": "az",
  "6": "a",
  "7": "a",
  "8": "az",
  "9": "a",
};

const VOWEL_RE = /[aeiouáéíóöőúüű]/i;

/** The lowercase definite article ("a" | "az") for a token. */
export function huDefiniteArticle(token: string | undefined | null): "a" | "az" {
  const t = (token ?? "").trim();
  if (!t) return "a";
  const first = t[0]!;
  if (/\d/.test(first)) return DIGIT_ARTICLE[first] ?? "a";
  // Uppercase start → identifier / model code / sorszam: the article
  // follows the LETTER's name ("M26057" = "em…" → az).
  if (/[A-ZÁÉÍÓÖŐÚÜŰ]/.test(first)) {
    return VOWEL_START_LETTER_NAMES.has(first.toUpperCase()) ? "az" : "a";
  }
  // Lowercase start → real word / phrase: the article follows the
  // first SOUND ("elsötétült…" → az, "kijelző…" → a).
  return VOWEL_RE.test(first) ? "az" : "a";
}

/** Sentence-start ("Az" / "A") + token: "Az M26057", "A B25082210". */
export function huThe(token: string | undefined | null): string {
  const a = huDefiniteArticle(token);
  return `${a === "az" ? "Az" : "A"} ${token ?? ""}`;
}

/** Citation form: "a B25082210 számú" (lowercase article + "számú"). */
export function huCite(sorszam: string | undefined | null): string {
  return `${huDefiniteArticle(sorszam)} ${sorszam ?? ""} számú`;
}
