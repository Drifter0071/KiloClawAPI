// Phase 1 classifier tests.
//
// The classifier is pure: given (reported, work, devices), it returns
// {kategoria_inferred, sulyossag_inferred, alkategoria_inferred, ...}.
// We test representative cases for each kategoria, each severity, and
// the device-family subcategory.

import { test, expect, describe } from "bun:test";
import { classify, classifyText } from "../src/lib/classifier";

describe("classifier: kategoria", () => {
  test("'plc program' -> Szoftver/PLC program hiba", () => {
    const r = classifyText("A PLC program nem fut le rendesen");
    expect(r.kategoria_inferred).toBe("Szoftver/PLC program hiba");
    expect(r.kategoria_confidence).toBeGreaterThan(0);
  });
  test("'szervo motor hiba' -> Szervo / hajtas hiba", () => {
    const r = classifyText("Az orrservo motor hibát jelez");
    expect(r.kategoria_inferred).toBe("Szervo / hajtas hiba");
  });
  test("'kijelző sötét' -> Kijelzo / HMI", () => {
    const r = classifyText("A kijelző sötét, nem látni semmit");
    expect(r.kategoria_inferred).toBe("Kijelzo / HMI");
  });
  test("'távoli elérés' -> Halozat / tavoli eleres", () => {
    const r = classifyText("Távoli elérés nem működik");
    expect(r.kategoria_inferred).toBe("Halozat / tavoli eleres");
  });
  test("'áramkimaradás' -> Tapellatas / vedelem", () => {
    const r = classifyText("Áramkimaradás miatt állt le a gép");
    expect(r.kategoria_inferred).toBe("Tapellatas / vedelem");
  });
  test("'karbantartás' -> Karbantartas / preventiv", () => {
    const r = classifyText("Éves karbantartás elvégzése");
    expect(r.kategoria_inferred).toBe("Karbantartas / preventiv");
  });
  test("'üzem behelyezés' -> Gepbeszereles / telepites", () => {
    const r = classifyText("Új gép üzembehelyezése a telephelyen");
    expect(r.kategoria_inferred).toBe("Gepbeszereles / telepites");
  });
  test("'képzés kérés' -> Kepzes / oktatas", () => {
    const r = classifyText("Képzés kérése a kezelőknek");
    expect(r.kategoria_inferred).toBe("Kepzes / oktatas");
  });
  test("'beállítás kérés' -> Mech./beallitas", () => {
    const r = classifyText("Finomhangolás szükséges a főorsón");
    expect(r.kategoria_inferred).toBe("Mech./beallitas");
  });
  test("vague text -> Egyeb", () => {
    const r = classifyText("valami furcsa dolog tortent a geppel");
    expect(r.kategoria_inferred).toBe("Egyeb");
    expect(r.kategoria_confidence).toBe(0);
  });
});

describe("classifier: sulyossag", () => {
  test("'vészleállás' -> kritikus 0.9", () => {
    const r = classifyText("Vészleállás történt a főorsón");
    expect(r.sulyossag_inferred).toBe("kritikus");
    expect(r.sulyossag_confidence).toBeGreaterThanOrEqual(0.7);
  });
  test("'gép leállt' -> magas", () => {
    const r = classifyText("A gép leállt, nem indul újra");
    expect(["magas", "kritikus"]).toContain(r.sulyossag_inferred);
  });
  test("'beállítás kérés' -> alacsony", () => {
    const r = classifyText("Beállítás kérés: paraméterek átállítása");
    expect(r.sulyossag_inferred).toBe("alacsony");
  });
  test("vague -> kozepes 0.4 (default)", () => {
    const r = classifyText("valami tortent");
    expect(r.sulyossag_inferred).toBe("kozepes");
    expect(r.sulyossag_confidence).toBe(0.4);
  });
});

describe("classifier: alkategoria (device family)", () => {
  test("device model NCT104 -> NCT104", () => {
    const r = classify({ reported: "valami", devices: [{ model: "NCT104" }] });
    expect(r.alkategoria_inferred).toBe("NCT104");
  });
  test("device model TMV-400 -> TMV-400", () => {
    const r = classify({ reported: "valami", devices: [{ model: "TMV-400" }] });
    expect(r.alkategoria_inferred).toBe("TMV-400");
  });
  test("mentions NCT99 in text -> NCT99 fallback", () => {
    const r = classifyText("Az NCT99 vezérlő lefagyott");
    expect(r.alkategoria_inferred).toBe("NCT99");
  });
  test("no device family -> null", () => {
    const r = classifyText("Beállítás kérés");
    expect(r.alkategoria_inferred).toBeNull();
  });
});

describe("classifier: determinism", () => {
  test("same input -> same output, every time", () => {
    const a = classifyText("PLC program hiba a NCT104-en", "újraindítás, parameter betoltes");
    const b = classifyText("PLC program hiba a NCT104-en", "újraindítás, parameter betoltes");
    expect(a).toEqual(b);
  });
});
