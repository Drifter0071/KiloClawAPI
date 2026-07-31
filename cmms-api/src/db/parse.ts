// Hungarian-friendly text utilities + device parser.
// `KÉSZÜLÉK TIPUSA` cells look like:
//   TMV-400(10297;M10170);NCT99M;CRT15";
//   NilesDFS-2(740 0005 22);NCT2000;CRT9";SW-1.039;HW:int;Servok:Siemens-DC;12 poz.rev.fej;Aut:tokmány;szegnyereg;forg.szállító;
//
// We split on ';', then for each token we try to extract:
//   model:   the leading identifier, possibly with a parenthesized (id1;id2) tail
//   software: the SW-... value (last one wins within a token, or a global one)
//   hardware: the HW:... value
//   servos:   the Servok:... value
//   freeform: any text that did not match

const FOLD_MAP: Record<string, string> = {
  á: "a", Á: "A",
  é: "e", É: "E",
  í: "i", Í: "I",
  ó: "o", Ó: "O",
  ö: "o", Ö: "O",
  ő: "o", Ő: "O",
  ú: "u", Ú: "U",
  ü: "u", Ü: "U",
  ű: "u", Ű: "U",
};

export function fold(input: string | null | undefined): string {
  if (input == null) return "";
  let out = "";
  for (const ch of String(input)) {
    out += FOLD_MAP[ch] ?? ch;
  }
  return out.toLowerCase().trim();
}

// Tokenize for the AND-of-tokens search. Splits on whitespace and
// most punctuation that is not part of a model id (letters, digits,
// dot, dash, slash, underscore kept). Empty tokens dropped.
export function tokenize(input: string): string[] {
  return fold(input)
    .split(/[^a-z0-9._\/\-]+/)
    .filter((t) => t.length > 0);
}

export type ParsedDevice = {
  raw: string;
  model: string | null;
  model_ascii: string | null;
  software: string | null;
  hardware: string | null;
  servos: string | null;
  controller: string | null;
  machine_type: string | null;
  freeform: string | null;
};

const SW_RE = /SW[-_:.\s]*([A-Za-z0-9.\-]+)/i;
const HW_RE = /HW[-_:.\s]*([A-Za-z0-9.\-]+)/i;
const SERVOK_RE = /Servok[-_:.\s]*([^;]+)/i;
const MODEL_HEAD_RE = /^([A-Za-z][A-Za-z0-9._\/\-]*)/;

const CONTROLLER_PREFIXES = [
  "NCT", "Siemens", "Fanuc", "Mitsubishi", "Heidenhain", "Bosch",
  "Allen-Bradley", "Beckhoff", "Mitsubishi", "Omron", "Keyence",
  "ABB", "Lenze", "Danfoss", "Yaskawa", "Delta", "LS", "Schneider",
  "Eaton", "Wago", "Codesys", "PLC", "IPC",
];

// Prefixes that indicate a token is NOT a machine type (it's metadata/accessory).
const NON_MACHINE_PREFIXES = [
  "sw", "hw", "servok", "aut", "vizipisztoly", "pc-s", "nk.bin",
];

// Hungarian words/abbreviations that appear as device tokens but are NOT machine types.
const NON_MACHINE_WORDS = new Set([
  "forg", "esis", "smax", "hdh", "munkat", "billenty", "revfej",
  "kihelyezett", "csap", "hidraulikus", "szalagos", "gyorsmenet",
  "fúr", "mar", "eszterg", "húz", "vág", "hev", "hűt", "mos",
  "szállít", "adagol", "emel", "fordul", "kemény", "puha",
  "nagy", "kis", "bal", "jobb", "fel", "le", "elő", "utó",
  "kulcs", "szorít", "befogó", "tokmány", "szegnyereg",
  "olajh", "villamos", "olajlev", "szervomotorok", "hajtott", "egysz",
  "olajsz", "olajsziv", "olajte", "szervo", "hajtás", "hajt",
  "szivattyú", "komp", "sűrít", "hűtő", "hűtés", "fűt", "fűtés",
  "levegő", "gáz", "olaj", "víz", "szenny", "porsz", "por",
  "riaszt", "bizt", "világít", "jelző", "kapcsoló", "relay",
  "szenzor", "mérő", "adat", "kijelző", "panel", "kezelő",
  "szekrény", "állvány", "talp", "keret", "váz", "test",
  "eredeti", "ors", "servo", "spir", "renishaw", "tokm", "fogasker",
  "csapágy", "lencse", "lánc", "szíj", "szeg", "csavar",
  "leveg", "fels", "szersz", "alsó", "felső", "bal", "jobb",
  "elő", "utó", "kézi", "automata", "fél", "teljes", "nagy",
  "kis", "extra", "speciális", "alap", "standard",
]);

function extractMachineType(model: string | null, raw: string): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  // Skip non-machine tokens (SW, HW, Servok, etc.)
  for (const prefix of NON_MACHINE_PREFIXES) {
    if (lower.startsWith(prefix)) return null;
  }
  // Skip known Hungarian non-machine words.
  if (NON_MACHINE_WORDS.has(lower)) return null;
  // Skip controller tokens — they're captured by extractController instead.
  for (const prefix of CONTROLLER_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) return null;
  }
  // Skip very short tokens (1-2 chars) — likely abbreviations or noise.
  if (model.length <= 2) return null;
  // Skip tokens that look like plain single letters or numbers.
  if (/^[A-Za-z]$/.test(model) || /^\d+$/.test(model)) return null;
  return model;
}

function extractController(model: string | null, servos: string | null): string | null {
  // Try to extract from servos field first (most reliable).
  // e.g. "Servok:Siemens-DC" → "Siemens-DC"
  if (servos) {
    const lower = servos.toLowerCase();
    for (const prefix of CONTROLLER_PREFIXES) {
      if (lower.includes(prefix.toLowerCase())) {
        // Return the full servos value trimmed, not just the prefix.
        return servos.trim();
      }
    }
  }
  // Try model prefix: "NCT99M" → "NCT99M", "NCT2000" → "NCT2000", "Siemens-S7-300" → "Siemens-S7-300".
  if (model) {
    for (const prefix of CONTROLLER_PREFIXES) {
      if (model.toLowerCase().startsWith(prefix.toLowerCase())) {
        // Return the full model, not just the prefix.
        return model;
      }
    }
  }
  return null;
}

export function parseDeviceCell(cell: string | null | undefined): ParsedDevice[] {
  if (cell == null) return [];
  const trimmed = String(cell).trim();
  if (trimmed === "") return [];

  // Split on ';' but keep parenthesized groups intact.
  const tokens: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of trimmed) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      if (buf.trim() !== "") tokens.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim() !== "") tokens.push(buf.trim());

  const out: ParsedDevice[] = [];
  for (const tok of tokens) {
    if (tok === "") continue;
    const headMatch = tok.match(MODEL_HEAD_RE);
    const model = headMatch ? headMatch[1] : null;
    const swMatch = tok.match(SW_RE);
    const hwMatch = tok.match(HW_RE);
    const servokMatch = tok.match(SERVOK_RE);

    // Freeform = anything in the token that is not model, not (sw|hw|servok):
    let free: string | null = tok;
    if (model) free = free.replace(model, "");
    if (swMatch) free = free.replace(swMatch[0], "");
    if (hwMatch) free = free.replace(hwMatch[0], "");
    if (servokMatch) free = free.replace(servokMatch[0], "");
    free = free.replace(/[();,\s]+/g, " ").trim();
    if (free === "") free = null;

    out.push({
      raw: tok,
      model,
      model_ascii: model ? fold(model) : null,
      software: swMatch ? swMatch[1] : null,
      hardware: hwMatch ? hwMatch[1] : null,
      servos: servokMatch ? servokMatch[1].trim() : null,
      controller: extractController(model, servokMatch ? servokMatch[1].trim() : null),
      machine_type: extractMachineType(model, tok),
      freeform: free,
    });
  }
  return out;
}

export function parseDateDot(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (s === "") return null;
  // Accept YYYY.MM.DD or YYYY-MM-DD
  const m1 = s.match(/^(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (m1) {
    const y = m1[1];
    const mo = m1[2].padStart(2, "0");
    const d = m1[3].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  return null;
}
