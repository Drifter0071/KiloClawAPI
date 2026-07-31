// Unit tests for the device parser and diacritic fold. These are the
// foundations of the AI-facing search and write paths.
import { describe, test, expect } from "bun:test";
import { fold, tokenize, parseDeviceCell, parseDateDot } from "../src/db/parse";

describe("fold", () => {
  test("lowercases and folds Hungarian diacritics", () => {
    expect(fold("Készülék Típusa")).toBe("keszulek tipusa");
    expect(fold("TÁVOLI")).toBe("tavoli");
    expect(fold("ÜH. GARANCIA")).toBe("uh. garancia");
  });
  test("handles null and empty", () => {
    expect(fold(null)).toBe("");
    expect(fold("")).toBe("");
    expect(fold(undefined)).toBe("");
  });
  test("preserves non-letter characters", () => {
    expect(fold("TMV-400(10297;M10170)")).toBe("tmv-400(10297;m10170)");
  });
});

describe("tokenize", () => {
  test("splits on non-alphanum, drops empty", () => {
    expect(tokenize("TMV-400 CRT15\"; SW-1.039")).toEqual(["tmv-400", "crt15", "sw-1.039"]);
  });
  test("folds diacritics", () => {
    expect(tokenize("készülék nem indul")).toEqual(["keszulek", "nem", "indul"]);
  });
});

describe("parseDeviceCell", () => {
  test("splits on semicolons, parses model+software+hardware+servos", () => {
    const r = parseDeviceCell("NilesDFS-2(740 0005 22);NCT2000;CRT9\";SW-1.039;HW:int;Servok:Siemens-DC;");
    expect(r.length).toBe(6);
    expect(r[0].model).toBe("NilesDFS-2");
    expect(r[0].raw).toBe("NilesDFS-2(740 0005 22)");
    // The SW/HW/Servok tokens are parsed as their own device entries,
    // because the parser splits first and then runs per-token regexes.
    // SW-1.039 -> model='SW-1.039', software='1.039'.
    // HW:int   -> model='HW',       hardware='int'.
    // Servok:Siemens-DC -> model='Servok', servos='Siemens-DC'.
    expect(r[3].model).toBe("SW-1.039");
    expect(r[3].software).toBe("1.039");
    expect(r[4].model).toBe("HW");
    expect(r[4].hardware).toBe("int");
    expect(r[5].model).toBe("Servok");
    expect(r[5].servos).toBe("Siemens-DC");
  });

  test("keeps parens intact when splitting", () => {
    const r = parseDeviceCell("TMV-400(10297;M10170);NCT99M");
    expect(r.length).toBe(2);
    expect(r[0].model).toBe("TMV-400");
    expect(r[0].raw).toBe("TMV-400(10297;M10170)");
  });

  test("handles empty and null", () => {
    expect(parseDeviceCell("")).toEqual([]);
    expect(parseDeviceCell(null)).toEqual([]);
  });
});

describe("parseDateDot", () => {
  test("converts YYYY.MM.DD to ISO", () => {
    expect(parseDateDot("2020.11.06")).toBe("2020-11-06");
    expect(parseDateDot("2020.1.6")).toBe("2020-01-06");
  });
  test("accepts dash form too", () => {
    expect(parseDateDot("2020-11-06")).toBe("2020-11-06");
  });
  test("null in -> null out", () => {
    expect(parseDateDot(null)).toBeNull();
    expect(parseDateDot("")).toBeNull();
  });
});
