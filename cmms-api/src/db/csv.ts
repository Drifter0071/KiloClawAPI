// CSV parser tuned for the messy Hungarian Excel exports in newIntegrationCSVs/.
//
// What it handles:
//   - RFC 4180 quoting ("..." with "" escapes and embedded commas / newlines)
//   - UTF-8 BOM at file start
//   - Multi-line header cells (e.g. "JAVÍTÁS HELYE\n1-GYÁRTÁS\n2-SZÉV\n3-EGYÉB")
//   - Trailing empty cells (rtrim of empty trailing fields per row)
//   - Tolerates ; or , as field delimiter
//
// The parser does NOT do any date/number normalization — that's the
// integrator's job. It returns string|null per cell.

export type CsvRow = (string | null)[];

export type ParsedCsv = {
  header: string[];
  rows: CsvRow[];
};

// Find the field delimiter by sniffing the first non-empty line.
// Prefer ';' if it's more common than ',' in the first ~1KB.
function detectDelimiter(text: string): string {
  const sample = text.slice(0, 4096);
  const semis = (sample.match(/;/g) || []).length;
  const commas = (sample.match(/,/g) || []).length;
  return semis > commas ? ";" : ",";
}

// Collapse a multi-line header cell into a single short key.
// "JAVÍTÁS HELYE\n1-GYÁRTÁS\n2-SZÉV\n3-EGYÉB" -> "JAVÍTÁS HELYE"
// Also lowercases and normalises whitespace for use as a column key.
export function flattenHeaderCell(cell: string): string {
  const first = cell.split(/\r?\n/)[0].trim();
  if (first === "") return cell.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? "";
  return first;
}

// Normalize a header string to a SQL-friendly snake_case-ish identifier.
export function normalizeHeader(cell: string): string {
  const flat = flattenHeaderCell(cell);
  // Replace any sequence of non-alphanumeric with underscore, trim leading/trailing _.
  const norm = flat
    .normalize("NFC")
    .replace(/[ÁáÉéÍíÓóÖöŐőÚúÜüŰű]/g, (c) => {
      // strip diacritics, keep ASCII letter
      return c.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    })
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return norm || "col";
}

export function parseCsv(input: string, opts?: { skipRows?: number; explicitHeader?: string[] }): ParsedCsv {
  // Strip BOM
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = detectDelimiter(text);

  const rowsRaw: string[][] = [];
  let cur: string[] = [];
  let c = "";
  let q = false;
  let j = 0;
  while (j < text.length) {
    const ch = text[j];
    if (q) {
      if (ch === '"') {
        if (text[j + 1] === '"') { c += '"'; j += 2; continue; }
        q = false; j++; continue;
      }
      c += ch; j++; continue;
    }
    if (ch === '"') { q = true; j++; continue; }
    if (ch === delim) { cur.push(c); c = ""; j++; continue; }
    if (ch === "\n" || ch === "\r") {
      cur.push(c); c = "";
      rowsRaw.push(cur); cur = [];
      if (ch === "\r" && text[j + 1] === "\n") j += 2; else j++;
      continue;
    }
    c += ch; j++;
  }
  if (c.length > 0 || cur.length > 0) { cur.push(c); rowsRaw.push(cur); }

  // Drop fully empty rows.
  const rows = rowsRaw.filter((r) => r.some((x) => x.trim() !== ""));

  if (rows.length === 0) return { header: [], rows: [] };

  // Caller can force a header (use when auto-detection is fooled by a
  // title or pre-header line).
  if (opts?.explicitHeader) {
    const uniq = dedupeHeader(opts.explicitHeader.map(normalizeHeader));
    const out: CsvRow[] = [];
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      const trimmed: CsvRow = [];
      for (let m = 0; m < uniq.length; m++) {
        const v = r[m] ?? "";
        trimmed.push(v === "" ? null : v);
      }
      if (trimmed.every((v) => v === null)) continue;
      out.push(trimmed);
    }
    return { header: uniq, rows: out };
  }

  // Skip a fixed number of leading rows before header detection (use when
  // the file has a title/description line(s) before the real header).
  const startSearch = Math.max(0, opts?.skipRows ?? 0);

  // Find the most common row length and the row with that length that
  // comes first — that's our header.
  const counts = new Map<number, number>();
  for (let k = startSearch; k < rows.length; k++) {
    counts.set(rows[k].length, (counts.get(rows[k].length) ?? 0) + 1);
  }
  let bestLen = 0;
  let bestCount = -1;
  for (const [k, v] of counts) {
    if (v > bestCount || (v === bestCount && k > bestLen)) {
      bestLen = k;
      bestCount = v;
    }
  }

  // Find the first row at-or-after startSearch of length bestLen (with
  // maybe a 1-cell tolerance for ragged final columns).
  let headerIdx = startSearch;
  for (let k = startSearch; k < Math.min(rows.length, startSearch + 10); k++) {
    if (Math.abs(rows[k].length - bestLen) <= 1) { headerIdx = k; break; }
  }
  const headerCells = rows[headerIdx].map(flattenHeaderCell);
  const header = headerCells.map(normalizeHeader);
  const uniqHeader = dedupeHeader(header);

  // Slice rows after the header; trim trailing empty cells in each row
  // so the arrays line up with the header length.
  const out: CsvRow[] = [];
  for (let k = headerIdx + 1; k < rows.length; k++) {
    const r = rows[k];
    // Pad/trim to header length
    const trimmed: CsvRow = [];
    for (let m = 0; m < uniqHeader.length; m++) {
      const v = r[m] ?? "";
      trimmed.push(v === "" ? null : v);
    }
    // Drop rows that are entirely empty (rare after filter above, but safe)
    if (trimmed.every((v) => v === null)) continue;
    out.push(trimmed);
  }

  return { header: uniqHeader, rows: out };
}

// De-dupe header names: if two columns normalize to the same key,
// append _2, _3, etc. This happens when a file has both "JAVÍTÁS HELYE"
// and an empty header.
function dedupeHeader(header: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h}_${n}`;
  });
}

// --- Date + number normalization (Hungarian CSVs use several formats) ---

// Accepts: YYYY/MM/DD, YYYY.MM.DD., YYYY-MM-DD, YYYYMMDD,
//          DD.MM. (when 4-digit year is at end), and Excel serial dates.
// Returns YYYY-MM-DD or null if unparseable.
export function normalizeDate(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (s === "") return null;
  // Strip trailing period (YYYY.MM.DD.)
  const t = s.replace(/\.+$/, "");
  // YYYY/MM/DD
  let m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  // YYYY.MM.DD
  m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  // YYYY-MM-DD
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  // DD.MM.YYYY  (last component 4-digit)
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  // DD/MM/YYYY
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  // YYYYMMDD
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Year only (e.g. "2022" in the statisztika file)
  m = /^(\d{4})$/.exec(t);
  if (m) return `${m[1]}-01-01`;
  return null;
}

function pad(s: string): string {
  return s.length === 1 ? `0${s}` : s;
}

// Hungarian decimal: "1,00" -> 1.0; "12,08%" -> 12.08 (strip %).
// Returns null if not a number.
export function normalizeNumber(input: string | null | undefined): number | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (s === "") return null;
  s = s.replace(/%$/, "").trim();
  if (s === "") return null;
  // Replace decimal comma with dot
  s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

// Coerce the textual "TRUE"/"FALSE" to 1/0 for boolean-ish columns.
export function normalizeBool(input: string | null | undefined): number | null {
  if (input == null) return null;
  const t = String(input).trim().toLowerCase();
  if (t === "true" || t === "igen" || t === "1") return 1;
  if (t === "false" || t === "nem" || t === "0") return 0;
  if (t === "") return null;
  return null;
}
