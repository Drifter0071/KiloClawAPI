// Tests for the Hungarian grammar engine (Approach A).
//
// The answer templates used to emit "A(z) X" as a universal cop-out.
// Hungarian attaches the definite article by PRONUNCIATION: identifiers
// are read letter-by-letter ("az M26057" — M = "em"), digits by their
// Hungarian name ("a 2-es" — kettő), real words by their first sound
// ("az alma", "a gép"). This module (src/lib/hu.ts) implements that
// deterministically, and attrSentence() (src/lib/answer_text.ts) uses
// it for attribute answers.

import { describe, expect, test } from "bun:test";
import { huDefiniteArticle, huThe, huCite } from "../src/lib/hu";
import { attrSentence } from "../src/lib/answer_text";

describe("huDefiniteArticle", () => {
  test("identifiers follow the LETTER name (M/B/N/T...)", () => {
    // M = "em" (vowel) -> az; B = "bé" (consonant) -> a.
    expect(huDefiniteArticle("M26057")).toBe("az");
    expect(huDefiniteArticle("B25082210")).toBe("a");
    expect(huDefiniteArticle("NCT-204")).toBe("az"); // N = "en"
    expect(huDefiniteArticle("A123")).toBe("az");    // A = "á"
    expect(huDefiniteArticle("TMV-400")).toBe("a");  // T = "té"
    expect(huDefiniteArticle("VÁMOSGÉP KFT.")).toBe("a"); // V = "vé"
  });
  test("digit-start tokens follow the digit name", () => {
    expect(huDefiniteArticle("1-es")).toBe("az"); // egy
    expect(huDefiniteArticle("2-es")).toBe("a");  // kettő
    expect(huDefiniteArticle("8-as")).toBe("az"); // nyolc
    expect(huDefiniteArticle("0-s")).toBe("az");  // nulla
    expect(huDefiniteArticle("3-as")).toBe("a");  // három
  });
  test("real words follow the first SOUND", () => {
    expect(huDefiniteArticle("alma")).toBe("az");
    expect(huDefiniteArticle("elsötétült")).toBe("az");
    expect(huDefiniteArticle("gép")).toBe("a");
    expect(huDefiniteArticle("kijelző")).toBe("a");
    expect(huDefiniteArticle("szervo")).toBe("a");
  });
  test("empty input falls back to 'a'", () => {
    expect(huDefiniteArticle("")).toBe("a");
    expect(huDefiniteArticle("   ")).toBe("a");
  });
});

describe("huThe (sentence-start)", () => {
  test("capitalizes the article", () => {
    expect(huThe("M26057")).toBe("Az M26057");
    expect(huThe("B25082210")).toBe("A B25082210");
    expect(huThe("NCT-204")).toBe("Az NCT-204");
    expect(huThe("VÁMOSGÉP KFT.")).toBe("A VÁMOSGÉP KFT.");
  });
});

describe("huCite (citation form)", () => {
  test("'a <sorszam> számú' with the right article", () => {
    expect(huCite("B25082210")).toBe("a B25082210 számú");
    expect(huCite("M17191")).toBe("az M17191 számú");
    expect(huCite("B26061802")).toBe("a B26061802 számú");
  });
});

describe("attrSentence uses the grammar engine", () => {
  test("sentence starts with the correct article + lowercase citation", () => {
    const s = attrSentence({
      entity: "M26057",
      attr: "controller",
      value: "NCT iHDW-A2",
      source: { sorszam: "B26071801", customer: "PLASMA-TECH SYSTEMS KFT.", date: "2026.07.18" },
      language: "hu",
    });
    expect(s).toBe(
      "Az M26057 vezérlése: NCT iHDW-A2. (forrás: B26071801, PLASMA-TECH SYSTEMS KFT., 2026.07.18)",
    );
  });
  test("no source renders no citation clause", () => {
    const s = attrSentence({ entity: "M17191", attr: "model", value: "DPB-3", language: "hu" });
    expect(s).toBe("Az M17191 modellje: DPB-3.");
  });
  test("consonant-start identifier gets 'A'", () => {
    const s = attrSentence({ entity: "B25082210", attr: "fault", value: "csapágy hiba", language: "hu" });
    expect(s).toBe("A B25082210 hibája: csapágy hiba.");
  });
  test("English path is untouched", () => {
    const s = attrSentence({
      entity: "M26057",
      attr: "controller",
      value: "NCT iHDW-A2",
      source: { sorszam: "B26071801" },
      language: "en",
    });
    expect(s).toBe("The M26057 controller: NCT iHDW-A2. (Source: B26071801)");
  });
});
