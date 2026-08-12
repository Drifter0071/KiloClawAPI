// answer_text.ts — turn a routed plan + executed result into a real
// answer sentence.
//
// The old summary generator was a pure counter ("N találat: sorszám"),
// which is useless for questions like "Milyen vezérlés található az
// M26057 gépen?" — the data (controller, software, machine type) is in
// JobCard.devices[] and the note bodies, we just never read it back.
//
// This module detects which attribute the question asks about and pulls
// it from the top result so /v1/answer actually answers.

export type AnswerAttr =
  | "controller"
  | "software"
  | "hardware"
  | "servos"
  | "machine_type"
  | "model"
  | "customer"
  | "status"
  | "date"
  | "fault";

type AttrRule = { attr: AnswerAttr; needles: string[] };

// Hungarian-first. Needles are matched against accent-normalized text
// (lowercased, accents stripped) so "vezérlés" == "vezerles".
const ATTR_RULES: AttrRule[] = [
  {
    attr: "controller",
    needles: ["vezerles", "vezerlo", "controller", "milyen nc", "nc vezerlo", "nc vezérlés", "vezerloje", "vezerlese"],
  },
  {
    attr: "software",
    needles: ["szoftver", "software", "firmware", "verzio", "verzió", "fw valtozat", "sw verzió"],
  },
  {
    attr: "hardware",
    needles: ["hardver", "hardware"],
  },
  {
    attr: "servos",
    needles: ["szervo", "szervó", "servo", "servok", "hajtas", "hajtás"],
  },
  {
    attr: "machine_type",
    needles: ["geptipus", "géptípus", "gép típus", "machine type", "milyen tipus", "milyen típus", "milyen gep", "milyen gép"],
  },
  {
    attr: "model",
    needles: ["modell", "milyen marka", "milyen márka", "milyen gyartmany", "milyen gyártmány"],
  },
  {
    attr: "customer",
    needles: ["ugyfel", "ügyfél", "customer", "kinek a gepe", "kinek a gépe", "tulajdonos", "kie ez", "kié ez"],
  },
  {
    attr: "status",
    needles: ["nyitott", "zart", "zárt", "nyitva", "le van zárva", "allapota", "állapota", "statusa", "státusza", "open", "closed"],
  },
  {
    attr: "date",
    needles: ["mikor", "datum", "dátum", "idopont", "időpont", "melyik nap", "which day", "when volt", "mettol", "meddig"],
  },
  {
    attr: "fault",
    needles: ["mi a baja", "mi a hibaja", "mi a hibája", "mit kellett", "mit kellett csinalni", "hiba mi volt", "milyen hiba"],
  },
];

// Normalize the same way the router does (NFD strip + lowercase).
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[?!.,;:]/g, " ");
}

/**
 * Detect which attribute the question asks about. Returns null when the
 * question is a plain list/count request (no attribute word).
 */
export function detectAttr(q: string): AnswerAttr | null {
  if (!q) return null;
  const t = norm(q);
  for (const rule of ATTR_RULES) {
    for (const n of rule.needles) {
      const nn = norm(n);
      // Short needles (<5 chars) could collide ("hw", "fw"); require
      // whole-word-ish match for those.
      if (nn.length >= 5 || new RegExp(`(^|\\s)${nn}(\\s|$)`).test(t)) {
        if (t.includes(nn)) return rule.attr;
      }
    }
  }
  return null;
}

const NOTE_RE: Record<string, RegExp> = {
  controller: /(?:vezérl[őo]|vezerl[őo]|controller)[^:\n]*[:]\s*([^\n;]+)/i,
  software: /\b(?:szoftver|software|firmware|sw)\b[^:\n]*[:=]\s*([^\n;]+)/i,
  hardware: /\b(?:hardver|hardware|hw)\b[^:\n]*[:=]\s*([^\n;]+)/i,
  servos: /\b(?:szervó|szervo|servo|servok|hajtás|hajtas)\b[^:\n]*[:=]\s*([^\n;]+)/i,
  machine_type: /\b(?:géptípus|geptipus|gép típus|machine type|típus|tipus)\b[^:\n]*[:]\s*([^\n;]+)/i,
  model: /\b(?:modell|márka|marka|gyártmány|gyartmany)\b[^:\n]*[:]\s*([^\n;]+)/i,
};

/**
 * Extract the attribute value from a JobCard (devices[] first, then a
 * note-body scan for explicit "Vezérlő: X" style lines).
 */
export function extractAttr(card: any, attr: AnswerAttr): string | null {
  if (!card) return null;

  const devices: Array<Record<string, any>> = Array.isArray(card.devices) ? card.devices : [];
  const notes: Array<{ body?: string }> = Array.isArray(card.notes) ? card.notes : [];
  const noteText = notes.map((n) => n.body ?? "").join("\n");

  // Prefer the note's explicit statement for controller questions —
  // "Vezérlő: NCT iHDW-A2 firmware v3.41" is more specific than the
  // parsed device model ("NCT99").
  if (attr === "controller") {
    const m = noteText.match(NOTE_RE.controller);
    if (m) {
      const v = m[1].trim();
      if (v && v.length > 1) return v;
    }
  }

  // Structured devices[] fields.
  const devField: Partial<Record<AnswerAttr, keyof Record<string, any>>> = {
    controller: "controller",
    software: "software",
    hardware: "hardware",
    servos: "servos",
    machine_type: "machine_type",
    model: "model",
  };
  const field = devField[attr];
  if (field) {
    const d = devices.find((x) => x[field]) ?? devices[0];
    if (d?.[field]) return String(d[field]).trim();
  }

  // Fallbacks for the remaining attrs.
  if (attr === "customer") {
    return card.customer?.name ?? null;
  }
  if (attr === "status") {
    if (card.status === "closed") return "lezárt";
    if (card.status === "open") return "nyitott";
    return card.status ?? null;
  }
  if (attr === "date") {
    return card.reported_at_iso ?? card.reported_at ?? null;
  }
  if (attr === "fault") {
    const reported = notes.find((n) => (n as any).kind === "reported");
    const work = notes.find((n) => (n as any).kind === "work");
    const pick = reported?.body || work?.body || notes[0]?.body || "";
    return pick ? (pick.length > 160 ? pick.slice(0, 157) + "..." : pick) : null;
  }

  // Note scan for the rest.
  const re = NOTE_RE[attr];
  if (re) {
    const m = noteText.match(re);
    if (m) {
      const v = m[1].trim();
      if (v && v.length > 1) return v;
    }
  }

  return null;
}

const LABEL_HU: Record<AnswerAttr, string> = {
  controller: "vezérlése",
  software: "szoftvere",
  hardware: "hardvere",
  servos: "szervóhajtása",
  machine_type: "géptípusa",
  model: "modellje",
  customer: "ügyfele",
  status: "állapota",
  date: "bejelentés dátuma",
  fault: "hibája",
};

const LABEL_EN: Record<AnswerAttr, string> = {
  controller: "controller",
  software: "software",
  hardware: "hardware",
  servos: "servo drives",
  machine_type: "machine type",
  model: "model",
  customer: "customer",
  status: "status",
  date: "reported date",
  fault: "fault",
};

/**
 * Build a one-sentence answer: "A(z) M26057 vezérlése: NCT99. (Forrás:
 * B26071801, PLASMA-TECH SYSTEMS KFT., 2026.07.18)".
 */
export function attrSentence(opts: {
  entity: string;
  attr: AnswerAttr;
  value: string;
  source?: { sorszam?: string; customer?: string; date?: string } | null;
  language: "hu" | "en";
}): string {
  const { entity, attr, value, source, language } = opts;
  const label = language === "hu" ? LABEL_HU[attr] : LABEL_EN[attr];
  // Only render a source citation when it has at least a sorszam —
  // stats rows (grouped {name,count}) aren't cards and have nothing
  // to cite.
  const parts = [source?.sorszam, source?.customer, source?.date].filter(Boolean) as string[];
  const src = parts.length > 0 ? ` (Forrás: ${parts.join(", ")})` : "";
  const srcEn = parts.length > 0 ? ` (Source: ${parts.join(", ")})` : "";
  return language === "hu"
    ? `A(z) ${entity} ${label}: ${value}.${src}`
    : `The ${entity} ${label}: ${value}.${srcEn}`;
}

/**
 * Build a source citation from the top result card.
 */
export function cardSource(card: any): { sorszam?: string; customer?: string; date?: string } | null {
  if (!card) return null;
  return {
    sorszam: card.sorszam ?? undefined,
    customer: card.customer?.name ?? undefined,
    date: card.reported_at_iso ?? card.reported_at ?? undefined,
  };
}
