// Phase 1: deterministic, keyword-based ticket classifier.
//
// Why this exists
// ---------------
// R4/R5/R6 in docs/cmms-mcp-redesign.md: the source data has
//   - "Egyeb" at 39% (overused human category),
//   - sulyossag 100% NULL,
//   - problem_alkategoria 100% NULL,
// so any question like "how many critical tickets are open?" returns
// nothing useful from the raw column.
//
// The classifier runs at insert time AND as a one-shot backfill on
// first open of an old DB. It is *pure* (no LLM call, no I/O, no
// network), so it is deterministic and reproducible across sessions
// — which is the whole point of Phase 1.
//
// Taxonomy
// --------
// We keep the *human* kategoria column untouched and write the result
// into `kategoria_inferred` (a separate column). The new column
// reflects the expanded taxonomy from the design doc §3.1; the human
// column is preserved for audit. Both are exposed in API responses.
//
// Severity uses the heuristic from the design doc §R5 with conservative
// confidence values. Confidence is exposed next to the inferred value
// so callers can decide what threshold to use.

export type InferredKategoria =
  | "Szoftver/PLC program hiba"
  | "Vezerlo hardver hiba"
  | "Szervo / hajtas hiba"
  | "Mech./beallitas"
  | "Gepbeszereles / telepites"
  | "Karbantartas / preventiv"
  | "Kijelzo / HMI"
  | "Halozat / tavoli eleres"
  | "Tapellatas / vedelem"
  | "Csatlakozo / kabel"
  | "Kepzes / oktatas"
  | "Egyeb";

export type InferredSulyossag = "alacsony" | "kozepes" | "magas" | "kritikus";

export type Classification = {
  kategoria_inferred: InferredKategoria;
  kategoria_confidence: number; // 0..1
  sulyossag_inferred: InferredSulyossag;
  sulyossag_confidence: number; // 0..1
  alkategoria_inferred: string | null; // device family if present
  // For debugging / model inspection: which keywords fired.
  triggers: { kategoria: string[]; sulyossag: string[]; alkategoria: string[] };
};

export type ClassifierInput = {
  reported?: string | null;
  work?: string | null;
  devices?: { model?: string | null; controller?: string | null; machine_type?: string | null; raw?: string | null }[];
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Fold a string to lowercase ASCII (no diacritics) for keyword matching.
// We keep it dependency-free; the same approach is used in db/parse.ts.
function norm(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9\s\.\-\/]/g, " ");
}

function joinText(input: ClassifierInput): string {
  const parts: string[] = [];
  if (input.reported) parts.push(input.reported);
  if (input.work) parts.push(input.work);
  for (const d of input.devices ?? []) {
    if (d?.model) parts.push(d.model);
    if (d?.controller) parts.push(d.controller);
    if (d?.machine_type) parts.push(d.machine_type);
    if (d?.raw) parts.push(d.raw);
  }
  return norm(parts.join(" "));
}

// ---------------------------------------------------------------------------
// Kategoria taxonomy — keyword bags
// ---------------------------------------------------------------------------
// Each entry is a list of phrases. A match is counted when ALL tokens
// of a phrase appear in order in the normalized text (with optional
// filler between them). We bias toward the more specific categories
// first (szoftver before vezerlo, szervo before mech, etc.) and the
// classifier picks the highest-scoring category.
//
// Confidence is `min(1, hit_count / 3)` — three keyword hits in one
// ticket is a strong signal. Single hits get 0.4.

const KATEGORIA_RULES: { kategoria: InferredKategoria; phrases: string[][] }[] = [
  {
    // R4 fix: pull software-classified cases out of "Egyeb" and "Vezerlo hiba".
    kategoria: "Szoftver/PLC program hiba",
    phrases: [
      ["plc", "program"],
      ["parameterek", "betoltes"],
      ["parameter", "betoltes"],
      ["szoftver", "frissites"],
      ["szoftver", "update"],
      ["bootolas"],
      ["licenc"],
      ["verzio", "frissites"],
      ["winpc"],
      ["nc", "program"],
      ["plc", "hiba"],
      ["program", "futtatas"],
      ["software", "fault"],
      ["szoftver", "hiba"],
      ["frissitettuk"],
      ["verziot", "valtottunk"],
    ],
  },
  {
    kategoria: "Vezerlo hardver hiba",
    phrases: [
      ["vezerlo", "csere"],
      ["vezérlő", "csere"],
      ["nc", "vezerlo"],
      ["plc", "modul"],
      ["igbt"],
      ["hajtas", "modul"],
      ["hajtás", "modul"],
      ["vezérlő", "panel"],
      ["vezerlo", "panel"],
      ["kardan", "panel"],
      ["servo", "drive"],
      ["servo", "amplifier"],
    ],
  },
  {
    kategoria: "Szervo / hajtas hiba",
    phrases: [
      ["szervo", "motor"],
      ["szervo", "hiba"],
      ["szervó", "hiba"],
      ["szervomotor"],
      ["orrservo"],
      ["hajtas", "motor"],
      ["hajtás", "motor"],
      ["főorsó", "motor"],
      ["főorso", "motor"],
      ["y", "tengely", "motor"],
      ["z", "tengely", "motor"],
      ["x", "tengely", "motor"],
      ["szankorrekcio"],
      ["encoder", "hiba"],
      ["referenciapont", "felvetel", "sikertelen"],
    ],
  },
  {
    kategoria: "Kijelzo / HMI",
    phrases: [
      ["kijelzo", "sotet"],
      ["kijelzo", "halvany"],
      ["monitor", "hiba"],
      ["hmi", "hiba"],
      ["kepernyo", "hiba"],
      ["kijelző", "törött"],
      ["crt"],
      ["lcd", "panel"],
      ["touch", "screen"],
    ],
  },
  {
    kategoria: "Halozat / tavoli eleres",
    phrases: [
      ["tavoli", "eleres"],
      ["távoli", "elérés"],
      ["halozat", "hiba"],
      ["wifi", "hiba"],
      ["internet", "nincs"],
      ["vpn", "kapcsolat"],
      ["teamviewer"],
      ["router", "csere"],
      ["ip", "cim", "konfliktus"],
      ["dns"],
    ],
  },
  {
    kategoria: "Tapellatas / vedelem",
    phrases: [
      ["aramkimaradas"],
      ["feszultseg", "ingadozas"],
      ["biztositek", "cserelve"],
      ["biztosíték", "csere"],
      ["tapegyseg", "csere"],
      ["tápegység", "csere"],
      ["tuz", "veszely"],
      ["tűz", "veszély"],
      ["feszultseg", "kimaradas"],
      ["túláram"],
      ["vedelem", "leold"],
    ],
  },
  {
    kategoria: "Csatlakozo / kabel",
    phrases: [
      ["csatlakozo", "laz"],
      ["kabel", "szaraz"],
      ["kabel", "csere"],
      ["csatlakozó", "törött"],
      ["dugasz", "csere"],
      ["d-sub", "csere"],
      ["x1", "csatlakozo"],
      ["kabel", "sérült"],
      ["csatlakozó", "csere"],
    ],
  },
  {
    kategoria: "Mech./beallitas",
    phrases: [
      ["beallitas", "kerelem"],
      ["beállítás", "kérés"],
      ["kalibralas"],
      ["finomhangolas"],
      ["parameterek", "atallitasa"],
      ["mechanikus", "kopas"],
      ["csapagy", "csere"],
      ["csapagy", "zas"],
      ["lanc", "feszites"],
      ["szij", "csere"],
      ["szij", "laz"],
    ],
  },
  {
    kategoria: "Gepbeszereles / telepites",
    phrases: [
      ["uzembehelyezes"],
      ["üzembehelyezés"],
      ["telepites", "utan"],
      ["telepítés", "után"],
      ["bekotes"],
      ["bekötés"],
      ["atadas", "atvetel"],
      ["átadás", "átvétel"],
      ["atalakitas"],
      ["átszerelés"],
      ["modositas", "gepen"],
    ],
  },
  {
    kategoria: "Karbantartas / preventiv",
    phrases: [
      ["karbantartas"],
      ["karbantartás"],
      ["preventiv", "ellenorzes"],
      ["preventív", "ellenőrzés"],
      ["olaj", "csere"],
      ["kenoanyag"],
      ["tisztitas"],
      ["tisztítás"],
      ["ellenorzes", "ciklus"],
    ],
  },
  {
    kategoria: "Kepzes / oktatas",
    phrases: [
      ["kepzes"],
      ["képzés"],
      ["oktatas"],
      ["oktatás"],
      ["betanitas"],
      ["betanítás"],
      ["dokumentacio", "kerelem"],
      ["manual", "kerelem"],
    ],
  },
];

// ---------------------------------------------------------------------------
// Sulyossag heuristic — confidence-weighted
// ---------------------------------------------------------------------------
// We use high-confidence triggers for magas/kritikus and lower for the
// "beallitas" soft cases. Default is kozepes@0.4 (the model can be
// honest about uncertainty).

const SULYOSSAG_RULES: { severity: InferredSulyossag; confidence: number; phrases: string[][] }[] = [
  {
    severity: "kritikus",
    confidence: 0.9,
    phrases: [
      ["veszleallas"],
      ["vészleállás"],
      ["tuz"],
      ["tűz"],
      ["baleset"],
      ["főorso", "all"],
      ["főorsó", "áll"],
      ["teljesen", "leallt"],
      ["gep", "leallt"],
      ["gép", "leállt"],
      ["termeles", "all"],
      ["termelés", "áll"],
    ],
  },
  {
    severity: "magas",
    confidence: 0.7,
    phrases: [
      ["nem", "indul"],
      ["nem", "megy"],
      ["nem", "indul", "be"],
      ["leallt"],
      ["leállt"],
      ["nem", "indul", "el"],
      ["nem", "reagal"],
      ["nem", "inditja"],
      ["visszafordithatatlan"],
      ["kritikus", "figyelmeztetes"],
    ],
  },
  {
    severity: "alacsony",
    confidence: 0.7,
    phrases: [
      ["beallitas", "kerelem"],
      ["beállítás", "kérés"],
      ["finomhangolas"],
      ["parameterek", "atallitasa"],
      ["dokumentacio", "kerelem"],
      ["manual", "kerelem"],
      ["kepzes"],
      ["oktatas"],
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countPhraseHits(normalized: string, phrases: string[][]): number {
  let hits = 0;
  for (const phrase of phrases) {
    // Build a regex that allows any non-empty run of filler chars
    // between tokens. Filler must include at least one space or
    // punctuation, so we don't accidentally match 'plcprogram' as
    // 'plc program'.
    const escaped = phrase.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(escaped.join("[\\s\\p{P}]+"), "u");
    if (re.test(normalized)) hits++;
  }
  return hits;
}

function detectAlkategoria(input: ClassifierInput, normalized: string): { value: string | null; hits: string[] } {
  // Pull the first controller family or machine-type family.
  const hits: string[] = [];
  let value: string | null = null;
  for (const d of input.devices ?? []) {
    const candidates: (string | null | undefined)[] = [d.controller, d.machine_type, d.model];
    for (const c of candidates) {
      if (!c) continue;
      const m = norm(c);
      // Match the most specific identifier first: e.g. "NCT104", "TMV-400".
      const ident = m.match(/\b(nct[\s\-]?\d{2,4}|tmv[\s\-]?\d{2,4}|dpx?[\s\-]?\d{1,3}|d[abns][\s\-]?\d{2,4}|[a-z]{2,4}[\s\-]?\d{2,4})\b/);
      if (ident) {
        const v = ident[1].toUpperCase().replace(/\s+/g, "-");
        if (!value) value = v;
        hits.push(`device:${v}`);
        break;
      }
    }
    if (value) break;
  }
  // Fallback: if text mentions a controller family, use that.
  if (!value) {
    const m = normalized.match(/(\bnct[\s\-]?\d{2,4}\b|\btmv[\s\-]?\d{2,4}\b|\bips[\s\-]?\d{0,3}\b|\bihdw[\s\-]?\d{0,3}\b|\bkafo[\s\-]?\d{0,3}\b)/);
    if (m && m[1]) {
      value = m[1].toUpperCase().replace(/\s+/g, "-");
      hits.push(`text:${value}`);
    }
  }
  return { value, hits };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function classify(input: ClassifierInput): Classification {
  const text = joinText(input);

  // Kategoria: pick highest-hit category; ties broken by rule order
  // (the more specific one comes first).
  let bestKat: InferredKategoria = "Egyeb";
  let bestKatHits = 0;
  const katTriggers: string[] = [];
  for (const rule of KATEGORIA_RULES) {
    const hits = countPhraseHits(text, rule.phrases);
    if (hits > bestKatHits) {
      bestKat = rule.kategoria;
      bestKatHits = hits;
      katTriggers.length = 0;
      for (const p of rule.phrases) if (new RegExp(p.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\p{P}]+"), "u").test(text)) {
        katTriggers.push(p.join(" "));
      }
    }
  }
  const kategoriaConf = bestKat === "Egyeb" ? 0.0 : Math.min(1, 0.4 + bestKatHits * 0.2);

  // Sulyossag: highest-confidence matching rule wins; default kozepes 0.4.
  let bestSul: InferredSulyossag = "kozepes";
  let bestSulConf = 0.4;
  const sulTriggers: string[] = [];
  for (const rule of SULYOSSAG_RULES) {
    const hits = countPhraseHits(text, rule.phrases);
    if (hits > 0) {
      // If a higher-confidence rule also hits, the higher one wins.
      if (rule.confidence > bestSulConf) {
        bestSul = rule.severity;
        bestSulConf = rule.confidence;
        sulTriggers.length = 0;
        for (const p of rule.phrases) if (new RegExp(p.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\p{P}]+"), "u").test(text)) {
          sulTriggers.push(p.join(" "));
        }
      }
    }
  }

  const { value: alkategoria, hits: alkTriggers } = detectAlkategoria(input, text);

  return {
    kategoria_inferred: bestKat,
    kategoria_confidence: kategoriaConf,
    sulyossag_inferred: bestSul,
    sulyossag_confidence: bestSulConf,
    alkategoria_inferred: alkategoria,
    triggers: { kategoria: katTriggers, sulyossag: sulTriggers, alkategoria: alkTriggers },
  };
}

// Convenience helper for tests: classify from a flat text blob.
export function classifyText(reported: string, work?: string): Classification {
  return classify({ reported, work: work ?? null, devices: [] });
}
