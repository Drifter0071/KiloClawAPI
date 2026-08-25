// In-memory cache of JobCards keyed by job KEY.
//
// We rebuild from cmms_specialized.db after each ETL pass. The cache
// also supports in-place updates when a new job or note is appended
// via the API (so the next search sees it without a full rebuild).

import type { OpenDbs } from "../db/open";
import { fold, tokenize } from "../db/parse";
import { countVisits as countVisitsForNotes, activeFields, bucketByClusterKey, buildClusterKey, buildClusterSummaries, matchesDateFilter, matchesFilter, ticketSignature, summarizeCluster, type ProblemCluster, type Scope, type SignatureFilter } from "../lib/cluster";
import { classify, type Classification } from "../lib/classifier";
import { buildLinkageIndex, type LinkageIndex, type LinkageRef } from "../lib/linkage";

// Phase 7 L3: gzip helpers for cache snapshot persistence. Bun ships
// CompressionStream / DecompressionStream as globals — we wrap them
// here so the snapshot code stays readable. The Uint8Array<ArrayBuffer>
// casts are needed because Bun's Blob constructor is strict about
// ArrayBuffer vs SharedArrayBuffer.
async function gzipString(input: string): Promise<Uint8Array> {
  const blob = new Blob([input], { type: "application/json" });
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
async function gunzipString(input: ArrayBuffer | Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so the Blob constructor accepts
  // it (Uint8Array views over SharedArrayBuffer are rejected).
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const buf = new ArrayBuffer(src.byteLength);
  new Uint8Array(buf).set(src);
  const blob = new Blob([buf]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

export type Device = {
  raw: string;
  model: string | null;
  software: string | null;
  hardware: string | null;
  servos: string | null;
  controller: string | null;
  machine_type: string | null;
  freeform: string | null;
};

export type Note = {
  kind: "reported" | "work" | "free";
  body: string;
  author: string | null;
  created_at: string | null;
};

export type Customer = {
  name: string;
  zip: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
};

export type JobCard = {
  key: number;
  sorszam: string;
  reported_at: string | null;
  reported_at_iso: string | null;
  status: "open" | "closed";
  technician: string | null;
  customer: Customer;
  devices: Device[];
  notes: Note[];
  problem_kategoria: string | null;
  problem_alkategoria: string | null;
  sulyossag: string | null;
  /** Phase 1: auto-classified kategoria from free text. May equal human-entered
   *  value; may be different (especially for tickets originally filed as "Egyeb"). */
  kategoria_inferred: string | null;
  /** Phase 1: 0..1 confidence for `kategoria_inferred`. */
  kategoria_inferred_conf: number | null;
  /** Phase 1: auto-classified severity. Replaces the (always-NULL) human sulyossag. */
  sulyossag_inferred: string | null;
  /** Phase 1: 0..1 confidence for `sulyossag_inferred`. */
  sulyossag_inferred_conf: number | null;
  /** Phase 1: device-family subcategory (e.g. "NCT104", "TMV-400"). */
  alkategoria_inferred: string | null;
  /** 'open' | 'closed' | 'cancelled' | 'in_progress'. */
  resolution: string | null;
  /** Count of visit-line markers in the ticket's notes. Used for problem clustering. */
  _visit_count?: number;
  // ASCII-flattened haystacks for fast substring match.
  _haystack: string;
};

export type SearchHit = { job: JobCard; score: number };

export type SearchResult = { hits: SearchHit[]; total: number };

export type IndexCard = {
  topCustomers: { name: string; count: number }[];
  topModels: { name: string; count: number }[];
  topTechnicians: { name: string; count: number }[];
  topKategoriak: { name: string; count: number }[];
  /** Phase 1: top inferred kategoria after the auto-classifier ran. */
  topKategoriakInferred: { name: string; count: number }[];
  /** Phase 1: distribution of inferred severity. */
  topSulyossagInferred: { name: string; count: number }[];
  /** Phase 1: distribution of inferred device-family subcategory. */
  topAlkategoriaInferred: { name: string; count: number }[];
  statusCounts: { open: number; closed: number };
  totalJobs: number;
};

type DeviceIndexEntry = {
  name: string;
  cmmsCount: number;
  crossCount: number;
  topCustomer: string | null;
};

/** Clean a device's display name. The parser sometimes leaves
 *  `raw_type` as a parenthesized group with a leading empty entry
 *  (e.g. "(;M17191)" when the original cell was
 *  "TMV-400(10297;M17191);…"), and `model` may be null in that
 *  case. The picker should show the bare identifier — we strip
 *  leading non-alphanumeric noise and matching outer parens. */
export function cleanDeviceName(model: string | null, raw: string | null): string {
  // Prefer the model if present; it's already the cleaned head token.
  if (typeof model === "string") {
    const m = model.trim();
    if (m) return m;
  }
  const r = (raw ?? "").trim();
  if (!r) return "";
  // Strip outer matching parens, then strip leading non-alphanumeric
  // noise (e.g. "(;M17191)" → "M17191", ";;ABC" → "ABC").
  let out = r;
  const parenMatch = out.match(/^\((.*)\)$/);
  if (parenMatch) out = parenMatch[1]!;
  // If the inside is a ';' list, take the first non-empty token that
  // looks like a real identifier (starts with a letter or digit, has
  // length >= 2). This handles "10297;M17191" → "M17191" and
  // ";M17191" → "M17191".
  if (out.includes(";")) {
    for (const tok of out.split(";")) {
      const t = tok.trim();
      if (/^[A-Za-z0-9][A-Za-z0-9._\/\-]{1,}$/.test(t)) return t;
    }
  }
  // No ';' inside — strip leading noise characters that aren't
  // part of a typical identifier.
  out = out.replace(/^[^\p{L}\p{N}]+/u, "");
  return out.trim();
}

/** Pick the customer with the highest ticket count from
 *  `customerCounts`. Returns null when the map is empty (e.g.
 *  orphan devices with no recorded customer). */
function topCustomerFromCounts(counts: Map<string, number>): string | null {
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestN = -1;
  for (const [name, n] of counts) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

/** sqlite_master existence check (mirror of related.ts#tableExists —
 *  kept inline so the device index builder doesn't depend on the
 *  lib/ module). */
function tableExists(dbs: OpenDbs, name: string): boolean {
  try {
    const r = dbs.spec
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { 1?: number } | null;
    return !!r;
  } catch {
    return false;
  }
}

export class JobCache {
  private static _nextId = 0;
  private _id: number = ++JobCache._nextId;
  /** Handle to the open DBs. Optional so unit-test fixtures can
   *  construct an isolated cache (e.g. `new JobCache()`) without
   *  touching the real cmms_specialized.db. The cross-DB device
   *  counts are simply skipped when `dbs` is null. */
  private dbs: OpenDbs | null = null;
  private byKey: Map<number, JobCard> = new Map();
  private prefixIndex: Map<string, Set<number>> = new Map();

  /** Construct a cache. `dbs` is optional: production code passes
   *  nothing here and calls `buildFromDb(dbs)` once the DBs are
   *  open; unit-test fixtures may pass a real `OpenDbs` directly
   *  so the cross-DB device counts work even outside the
   *  buildFromDb() flow. */
  constructor(dbs?: OpenDbs) {
    this.dbs = dbs ?? null;
  }
  private linkage: LinkageIndex = { forward: new Map(), reverse: new Map(), total: 0 };
  private indexCard: IndexCard = {
    topCustomers: [],
    topModels: [],
    topTechnicians: [],
    topKategoriak: [],
    topKategoriakInferred: [],
    topSulyossagInferred: [],
    topAlkategoriaInferred: [],
    statusCounts: { open: 0, closed: 0 },
    totalJobs: 0,
  };

  buildFromDb(dbs: OpenDbs): void {
    this.byKey.clear();
    this.prefixIndex.clear();
    this.deviceCounts = null;
    this.dbs = dbs;

    // We open a fresh read-write connection to the spec DB file for
    // the bulk read. In our environment, the long-lived writer's
    // .query() AND .prepare() methods on the same connection have
    // been observed to return a stale snapshot for SELECTs after a
    // write transaction commits, even after WAL checkpoints. A fresh
    // connection always sees the latest committed data on disk.
    // The dbs.spec connection is still kept open for ongoing writes.
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const fresh = new Database(dbs.specializedPath);
    try {
      const customers = new Map<number, JobCard["customer"] & { name_ascii: string; address_ascii: string }>();
      {
        const stmt = fresh.prepare(
          `SELECT id, name, zip, address, phone, email, name_ascii, address_ascii FROM customers`,
        );
        for (const r of stmt.all() as any[]) {
          customers.set(Number(r.id), {
            name: r.name,
            zip: r.zip,
            address: r.address,
            phone: r.phone,
            email: r.email,
            name_ascii: r.name_ascii,
            address_ascii: r.address_ascii,
          });
        }
      }

      const devices = new Map<number, Device[]>();
      const deviceRows: any[] = [];
      {
        const stmt = fresh.prepare(
          `SELECT job_key, raw_type, model, software, hardware, servos, controller, machine_type, freeform, raw_type_ascii
           FROM devices ORDER BY id`,
        );
        for (const r of stmt.all() as any[]) {
          const k = Number(r.job_key);
          const arr = devices.get(k) ?? [];
          arr.push({
            raw: r.raw_type,
            model: r.model,
            software: r.software,
            hardware: r.hardware,
            servos: r.servos,
            controller: r.controller ?? null,
            machine_type: r.machine_type ?? null,
            freeform: r.freeform,
          });
          devices.set(k, arr);
          deviceRows.push(r);
        }
        for (const r of deviceRows) {
          const k = Number(r.job_key);
          const ascii = String(r.raw_type_ascii ?? "");
          for (const tok of tokenize(ascii)) {
            for (const len of [3, 4, 5]) {
              if (tok.length >= len) {
                const pref = tok.slice(0, len);
                const set = this.prefixIndex.get(pref) ?? new Set<number>();
                set.add(k);
                this.prefixIndex.set(pref, set);
              }
            }
          }
        }
      }

      const notes = new Map<number, Note[]>();
      {
        const stmt = fresh.prepare(
          `SELECT job_key, kind, body, author, created_at FROM notes ORDER BY id`,
        );
        for (const r of stmt.all() as any[]) {
          const k = Number(r.job_key);
          const arr = notes.get(k) ?? [];
          arr.push({
            kind: r.kind,
            body: r.body,
            author: r.author,
            created_at: r.created_at,
          });
          notes.set(k, arr);
        }
      }

      const jobs = fresh.prepare(
        `SELECT key, sorszam, reported_at, reported_at_iso, customer_id, technician, status,
                problem_kategoria, problem_alkategoria, sulyossag,
                kategoria_inferred, kategoria_inferred_conf,
                sulyossag_inferred, sulyossag_inferred_conf,
                alkategoria_inferred, resolution
         FROM jobs ORDER BY key`,
      ).all() as any[];

    let open = 0;
    let closed = 0;
    const custCount = new Map<string, number>();
    const modelCount = new Map<string, number>();
    const techCount = new Map<string, number>();
    const kategoriaCount = new Map<string, number>();
    // Phase 1: distributions for the inferred kategoria / sulyossag /
    // alkategoria columns. Exposed via the index card so callers can
    // sanity-check the classifier's output.
    const kategoriaInfCount = new Map<string, number>();
    const sulyossagInfCount = new Map<string, number>();
    const alkategoriaInfCount = new Map<string, number>();

    for (const r of jobs) {
      const key = Number(r.key);
      const cust = customers.get(Number(r.customer_id));
      const kategoria = r.problem_kategoria ?? null;
      const alkategoria = r.problem_alkategoria ?? null;
      const sulyossag = r.sulyossag ?? null;
      const kategoriaInf = r.kategoria_inferred ?? null;
      const kategoriaInfConf = r.kategoria_inferred_conf ?? null;
      const sulyossagInf = r.sulyossag_inferred ?? null;
      const sulyossagInfConf = r.sulyossag_inferred_conf ?? null;
      const alkategoriaInf = r.alkategoria_inferred ?? null;
      // NY/Z polarity (Phase 3 fix, 2026-07-31):
      //   0 → "closed" (the ticket is done / lezárt)
      //   1 → "open"   (the ticket is still active / nyitott)
      // Before this fix the cache assumed 0=open, 1=closed, which
      // matched the column header but NOT the actual business
      // convention on the source sheet. See tests/16-nyz-polarity.test.ts.
      const resolution = r.resolution ?? (Number(r.status) === 0 ? "closed" : "open");
      const cardNotes = notes.get(key) ?? [];
      const card: JobCard = {
        key,
        sorszam: r.sorszam,
        reported_at: r.reported_at,
        reported_at_iso: r.reported_at_iso,
        status: Number(r.status) === 0 ? "closed" : "open",
        technician: r.technician,
        customer: cust
          ? { name: cust.name, zip: cust.zip, address: cust.address, phone: cust.phone, email: cust.email }
          : { name: "(ismeretlen)", zip: null, address: null, phone: null, email: null },
        devices: devices.get(key) ?? [],
        notes: cardNotes,
        problem_kategoria: kategoria,
        problem_alkategoria: alkategoria,
        sulyossag,
        kategoria_inferred: kategoriaInf,
        kategoria_inferred_conf: kategoriaInfConf,
        sulyossag_inferred: sulyossagInf,
        sulyossag_inferred_conf: sulyossagInfConf,
        alkategoria_inferred: alkategoriaInf,
        resolution,
        _visit_count: countVisitsForNotes(cardNotes),
        _haystack: "",
      };
      card._haystack = buildHaystack(card);
      this.byKey.set(key, card);
      if (card.status === "open") open++;
      else closed++;
      if (cust) custCount.set(cust.name, (custCount.get(cust.name) ?? 0) + 1);
      if (card.technician) techCount.set(card.technician, (techCount.get(card.technician) ?? 0) + 1);
      if (kategoria) kategoriaCount.set(kategoria, (kategoriaCount.get(kategoria) ?? 0) + 1);
      if (kategoriaInf) kategoriaInfCount.set(kategoriaInf, (kategoriaInfCount.get(kategoriaInf) ?? 0) + 1);
      if (sulyossagInf) sulyossagInfCount.set(sulyossagInf, (sulyossagInfCount.get(sulyossagInf) ?? 0) + 1);
      if (alkategoriaInf) alkategoriaInfCount.set(alkategoriaInf, (alkategoriaInfCount.get(alkategoriaInf) ?? 0) + 1);
      for (const d of card.devices) {
        if (d.model) modelCount.set(d.model, (modelCount.get(d.model) ?? 0) + 1);
      }
    }

    this.indexCard = {
      topCustomers: topN(custCount, 200),
      topModels: topN(modelCount, 200),
      topTechnicians: topN(techCount, 200),
      topKategoriak: topN(kategoriaCount, 200),
      topKategoriakInferred: topN(kategoriaInfCount, 200),
      topSulyossagInferred: topN(sulyossagInfCount, 200),
      topAlkategoriaInferred: topN(alkategoriaInfCount, 200),
      statusCounts: { open, closed },
      totalJobs: this.byKey.size,
    };

    // Phase 5b: build the bidirectional sorszam-linkage index. O(N) scan
    // over all note bodies; on 65K tickets this is ~300ms. Done at
    // startup (or after each ETL), not on the request path.
    const t0 = performance.now();
    this.linkage = buildLinkageIndex(this);
    const elapsed = Math.round(performance.now() - t0);
    if (elapsed > 100) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ t: new Date().toISOString(), msg: "linkage_index_built", elapsed_ms: elapsed, total_refs: this.linkage.total }));
    }
    } finally {
      fresh.close();
    }
  }

  upsert(card: JobCard): void {
    card._visit_count = countVisitsForNotes(card.notes);
    card._haystack = buildHaystack(card);
    this.byKey.set(card.key, card);
    this.deviceCounts = null;
    // Cheap index invalidation: drop all prefix entries containing this key.
    for (const [pref, set] of this.prefixIndex) {
      if (set.has(card.key)) {
        set.delete(card.key);
        if (set.size === 0) this.prefixIndex.delete(pref);
      }
    }
    for (const tok of tokenize(card._haystack)) {
      for (const len of [3, 4, 5]) {
        if (tok.length >= len) {
          const pref = tok.slice(0, len);
          const set = this.prefixIndex.get(pref) ?? new Set<number>();
          set.add(card.key);
          this.prefixIndex.set(pref, set);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 7 L3: persistent cache snapshot.
  //
  // The full JobCache build is ~3 minutes in production (65K tickets,
  // cross-DB device counts, FTS-ish prefix index, ~300ms linkage scan).
  // systemd restarts the service in 5s on crash, but every crash costs
  // 3+ minutes of cold-start where every query 504s. Persisting the
  // ~325MB JSON to disk in gzip form (~30-50MB) and loading it on
  // startup drops the cold-start to <10s, which means the watchdog
  // can fully recover a crash without the user noticing.
  //
  // Only byKey is persisted — the derived state (prefixIndex, indexCard,
  // linkage, deviceIndex) is recomputed in <1s from byKey. cmmsMtimeMs
  // is stamped into the snapshot so a stale snapshot (cmms.db has
  // advanced since we wrote the file) is detected and the snapshot is
  // discarded in favour of a fresh buildFromDb().
  // -------------------------------------------------------------------------

  /**
   * Serialize the cache to a gzip-compressed JSON file. The file
   * format is intentionally simple (no msgpack / no native binary):
   *  - gzip via Bun's CompressionStream
   *  - JSON envelope: { version, cmmsMtimeMs, jobCount, byKey }
   *  - byKey is serialized as an array of [key, card] tuples to
   *    preserve insertion order and avoid object-keyed lookup
   *    issues on load.
   *
   * Per-field exclusion: _haystack (the diacritic-folded search
   * index per card) is OMITTED from the snapshot. It's recomputed
   * by rebuildDerived() in <1s and represents ~30-40% of the
   * snapshot size on 65K tickets. Excluding it keeps the file
   * under ~40MB and the JSON.parse under 200MB transient — well
   * within the 3.8GB RAM budget of the prod box.
   *
   * Atomic write: write to a temp path first, fsync, then rename
   * over the live path. A crash mid-write leaves the previous
   * snapshot intact, never a half-written file.
   */
  async saveSnapshot(
    snapshotPath: string,
    cmmsMtimeMs: number,
  ): Promise<{ jobs: number; bytes: number; ms: number }> {
    const t0 = performance.now();
    const entries: [number, Omit<JobCard, "_haystack">][] = [];
    for (const [k, v] of this.byKey) {
      // Strip the per-card search index; rebuildDerived will
      // recompute it from the rest of the card.
      const { _haystack, ...persistable } = v;
      entries.push([k, persistable]);
    }
    const envelope = {
      version: 2,
      cmmsMtimeMs,
      jobCount: entries.length,
      byKey: entries,
    };
    const json = JSON.stringify(envelope);
    const gz = await gzipString(json);
    // Atomic write: temp file + rename.
    const tmp = snapshotPath + ".tmp";
    await Bun.write(tmp, gz);
    const { rename } = await import("node:fs/promises");
    await rename(tmp, snapshotPath);
    const ms = Math.round(performance.now() - t0);
    return { jobs: entries.length, bytes: gz.byteLength, ms };
  }

  /**
   * Load byKey from a previously-saved snapshot. Returns true on
   * success, false if the file is missing, the envelope is malformed,
   * the version is unknown, or cmmsMtimeMs no longer matches the
   * current cmms.db mtime. The caller must run `rebuildDerived()`
   * after a successful load to repopulate the prefix index, the
   * index card, the linkage index, etc.
   */
  static async loadSnapshot(
    snapshotPath: string,
    expectedCmmsMtimeMs: number,
  ): Promise<{ byKey: Map<number, JobCard>; jobCount: number; bytes: number; ms: number } | null> {
    const t0 = performance.now();
    const file = Bun.file(snapshotPath);
    if (!(await file.exists())) return null;
    let gz: ArrayBuffer;
    let json: string;
    try {
      gz = await file.arrayBuffer();
      json = await gunzipString(gz);
    } catch {
      // Malformed gzip / truncated file / etc. Treat as "no
      // snapshot" so the caller falls through to buildFromDb().
      return null;
    }
    let envelope: any;
    try {
      envelope = JSON.parse(json);
    } catch {
      return null;
    }
    if (
      !envelope ||
      (envelope.version !== 1 && envelope.version !== 2) ||
      typeof envelope.cmmsMtimeMs !== "number" ||
      !Array.isArray(envelope.byKey)
    ) {
      return null;
    }
    if (envelope.cmmsMtimeMs !== expectedCmmsMtimeMs) {
      // The DB has been written to since we saved — the snapshot
      // is stale and using it would risk missing new rows or
      // serving phantom rows that were later deleted. Discard.
      return null;
    }
    const byKey = new Map<number, JobCard>();
    for (const [k, v] of envelope.byKey as [number, JobCard][]) {
      if (typeof k === "number" && v && typeof v === "object") {
        byKey.set(k, v);
      }
    }
    const ms = Math.round(performance.now() - t0);
    return {
      byKey,
      jobCount: byKey.size,
      bytes: gz.byteLength,
      ms,
    };
  }

  /**
   * Repopulate every piece of derived state (prefixIndex, indexCard,
   * linkage, deviceCounts, _deviceIndexFolded) from a freshly-loaded
   * byKey. The derived state is NOT persisted — it's cheap to
   * recompute and saves us from versioning headaches when the
   * shape of prefixIndex or the index card changes.
   *
   * Mirrors the second half of buildFromDb() — anything that runs
   * after the byKey loop there. Device index (the cross-DB scan)
   * is left lazy: it builds itself on the first listDevices() call.
   */
  rebuildDerived(): void {
    this.prefixIndex.clear();
    this.deviceCounts = null;
    this.deviceIndex = null;
    this._deviceIndexFolded = null;

    let open = 0;
    let closed = 0;
    const custCount = new Map<string, number>();
    const modelCount = new Map<string, number>();
    const techCount = new Map<string, number>();
    const kategoriaCount = new Map<string, number>();
    // Phase 1: distributions for the inferred kategoria / sulyossag /
    // alkategoria columns. Exposed via the index card so callers can
    // sanity-check the classifier's output.
    const kategoriaInfCount = new Map<string, number>();
    const sulyossagInfCount = new Map<string, number>();
    const alkategoriaInfCount = new Map<string, number>();

    for (const card of this.byKey.values()) {
      if (card.status === "open") open++;
      else closed++;
      if (card.customer?.name) {
        custCount.set(card.customer.name, (custCount.get(card.customer.name) ?? 0) + 1);
      }
      for (const d of card.devices) {
        if (d.model) modelCount.set(d.model, (modelCount.get(d.model) ?? 0) + 1);
      }
      if (card.technician) techCount.set(card.technician, (techCount.get(card.technician) ?? 0) + 1);
      if (card.problem_kategoria) kategoriaCount.set(card.problem_kategoria, (kategoriaCount.get(card.problem_kategoria) ?? 0) + 1);
      if (card.kategoria_inferred) kategoriaInfCount.set(card.kategoria_inferred, (kategoriaInfCount.get(card.kategoria_inferred) ?? 0) + 1);
      if (card.sulyossag_inferred) sulyossagInfCount.set(card.sulyossag_inferred, (sulyossagInfCount.get(card.sulyossag_inferred) ?? 0) + 1);
      if (card.alkategoria_inferred) alkategoriaInfCount.set(card.alkategoria_inferred, (alkategoriaInfCount.get(card.alkategoria_inferred) ?? 0) + 1);

      // Rebuild _haystack + prefixIndex (same logic as buildFromDb
      // and upsert). Note: buildFromDb seeds the prefix index from
      // the device rows' raw_type_ascii, but rebuildDerived runs
      // AFTER the haystack is built, so tokenizing the full
      // haystack covers the same tokens plus note bodies — a
      // strict superset, so the index is just as good.
      card._haystack = buildHaystack(card);
      for (const tok of tokenize(card._haystack)) {
        for (const len of [3, 4, 5]) {
          if (tok.length >= len) {
            const pref = tok.slice(0, len);
            const set = this.prefixIndex.get(pref) ?? new Set<number>();
            set.add(card.key);
            this.prefixIndex.set(pref, set);
          }
        }
      }
    }

    this.indexCard = {
      topCustomers: topN(custCount, 200),
      topModels: topN(modelCount, 200),
      topTechnicians: topN(techCount, 200),
      topKategoriak: topN(kategoriaCount, 200),
      topKategoriakInferred: topN(kategoriaInfCount, 200),
      topSulyossagInferred: topN(sulyossagInfCount, 200),
      topAlkategoriaInferred: topN(alkategoriaInfCount, 200),
      statusCounts: { open, closed },
      totalJobs: this.byKey.size,
    };

    // Linkage: ~300ms on 65K tickets in production. This is the
    // most expensive rebuild step, but still well under the 3-min
    // full ETL we used to do.
    const t0 = performance.now();
    this.linkage = buildLinkageIndex(this);
    const elapsed = Math.round(performance.now() - t0);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        msg: "linkage_index_built_from_snapshot",
        elapsed_ms: elapsed,
        total_refs: this.linkage.total,
      }),
    );
  }

  get(key: number): JobCard | undefined {
    return this.byKey.get(key);
  }

  /**
   * Find a JobCard by its public sorszam (BEJELENTÉS SORSZÁMA, e.g.
   * "B240326002"). Linear scan — there are ~65K cards in production and
   * the call is rare (the dashboard inspector / panel looks up one
   * ticket at a time), so an extra index isn't worth the bookkeeping
   * cost. Returns undefined if the sorszam is unknown.
   */
  getBySorszam(sorszam: string): JobCard | undefined {
    if (typeof sorszam !== "string" || sorszam.length === 0) return undefined
    for (const card of this.byKey.values()) {
      if (card.sorszam === sorszam) return card
    }
    return undefined
  }

  delete(key: number): boolean {
    const card = this.byKey.get(key);
    if (!card) return false;
    this.byKey.delete(key);
    this.deviceCounts = null;
    for (const [pref, set] of this.prefixIndex) {
      if (set.has(key)) {
        set.delete(key);
        if (set.size === 0) this.prefixIndex.delete(pref);
      }
    }
    return true;
  }

  size(): number {
    return this.byKey.size;
  }

  index(): IndexCard {
    return this.indexCard;
  }

  allJobs(): JobCard[] {
    return [...this.byKey.values()];
  }

  // -------------------------------------------------------------------------
  // Device suggestion index (machine-scoped ask).
  //
  // listDevices(q, limit) returns device identifiers whose model/raw
  // contains the query (case-insensitive, hyphen/space-insensitive), one
  // entry per distinct (cleaned) identifier, ranked by how many records
  // mention the device across ALL sources: main CMMS tickets +
  // serviz_belso + szev_igeny + telephely_munka. A ticket counts toward
  // a device only once even when it carries several devices with the
  // same identifier.
  //
  // `name` is the cleaned display string (model wins, with leading
  // "(;" / ";" / "(" stripped and trailing ")" stripped, so the
  // picker's "M17191" doesn't show as "(;M17191)"). `customer_name` is
  // the most-frequent customer that owns the device across all sources
  // (best-effort — same machine can have multiple customers over the
  // years; we show the dominant one so the operator can disambiguate
  // similar serial numbers).
  // -------------------------------------------------------------------------

  /** Cached device index. Rebuilt on every buildFromDb() / upsert() /
   *  delete(). Combines main-CMMS counts with cross-database
   *  (serviz/szev/telephely) counts so the picker surfaces the real
   *  number of records the agent will see — not just the cmms.db
   *  subset. Null until first build. */
  private deviceIndex: DeviceIndexEntry[] | null = null;
  /** Cached `name → foldedName` (lowercased, hyphens/spaces stripped)
   *  for the current deviceIndex. Populated lazily by listDevices().
   *  Reset whenever deviceIndex is rebuilt. */
  private _deviceIndexFolded: Map<string, string> | null = null;
  /** Lazily-built `cleanedName → { name, cmmsCount, crossCount, topCustomer }`
   *  map. Pre-aggregated so listDevices() is a simple substring scan
   *  + sort. */
  private deviceCounts: Map<string, number> | null = null;

  private buildDeviceCounts(): void {
    // Per-cleanedName counters.
    const perName = new Map<
      string,
      {
        cmmsCount: number;
        customerCounts: Map<string, number>;
      }
    >();
    // First pass: bucket by cleanDeviceName(model, raw). This is the
    // canonical "what does this device look like in the picker" path —
    // each ticket contributes 1 to its primary cleaned name.
    for (const card of this.byKey.values()) {
      const seen = new Set<string>();
      for (const d of card.devices) {
        const cleaned = cleanDeviceName(d.model, d.raw);
        if (!cleaned || seen.has(cleaned)) continue;
        seen.add(cleaned);
        const e = perName.get(cleaned) ?? { cmmsCount: 0, customerCounts: new Map() };
        e.cmmsCount += 1;
        const cname = (card.customer?.name ?? "").trim();
        if (cname) e.customerCounts.set(cname, (e.customerCounts.get(cname) ?? 0) + 1);
        perName.set(cleaned, e);
      }
    }

    // Second pass: count additional cmms tickets that mention a
    // serial-like identifier as a SUBSTRING in any device's raw_type
    // (e.g. "M17191" inside "WFQ-80NCT7.belső körasztal maró(;M15196;M17191)…").
    // The first pass only counted the ticket under its primary cleaned
    // name (the "WFQ-80NCT7.bels" head token), so an operator who
    // searches for the M-serial ("M17191") saw 1 ticket instead of the
    // real 62. This pass mirrors the fold-substring match that
    // find_related_tickets() already uses, so the picker number
    // approximates what the agent will actually find for that device.
    //
    // Performance: in production perName can hold 20k+ unique device
    // strings and prefixIndex can map a popular 4-char prefix
    // (e.g. "m171") to thousands of job keys. To keep this O(seconds)
    // rather than O(minutes) we only consider serial-like names that
    // already have at least one cmms row from pass 1 (a serial the
    // operator might plausibly search for) AND cap each candidate
    // shortlist to a sane size. In production the qualifying set is
    // usually under 200 M-serials with a few hundred candidates each,
    // and the fold-cache below keeps the per-card work to a single
    // string-search per qualifying card.
    const serialKeys: { k: string; f: string }[] = [];
    for (const [k, e] of perName) {
      if (e.cmmsCount === 0) continue; // not a candidate the operator will search
      const f = fold(k);
      if (!f || f.length < 4) continue;
      // Serial-like: M-prefix + ≥4 digits, OR compact id containing a
      // digit and made of alnum/dot/dash/slash/underscore.
      const isMserial = /^m\d{4,}$/.test(f);
      const isCompactIdWithDigit = /^[A-Za-z0-9._\/\-]{4,}$/.test(f) && /\d/.test(f);
      if (isMserial || isCompactIdWithDigit) {
        serialKeys.push({ k, f });
      }
    }
    if (serialKeys.length > 0) {
      // Build a serialKey → (set of job keys that MIGHT mention it)
      // shortlist using the existing prefixIndex. For each serial
      // key's 4-char prefix, we union the matching job-key sets. This
      // is a strict superset of "jobs whose raw_type contains the
      // serial" (prefixIndex was built from tokenize() of raw_type
      // ASCII text), so we still need the per-ticket
      // haystack.includes(f) check — but the candidate set is now
      // O(matches) not O(all jobs), so the loop is fast even with
      // thousands of serial keys. Empty shortlist for a serial =
      // nobody mentions it, skip the per-job loop entirely.
      const MAX_CANDIDATES_PER_SERIAL = 2000;
      const serialShortlists = new Map<string, Set<number>>();
      for (const { k, f } of serialKeys) {
        if (f.length < 4) continue;
        const pref = f.slice(0, 4);
        const set = this.prefixIndex.get(pref);
        if (!set || set.size === 0) continue;
        // Cap each shortlist to the first MAX_CANDIDATES_PER_SERIAL
        // jobs. The operator is searching for a specific serial, so
        // a 2k cap is plenty (typical M-serial has 1-200 mentions);
        // anything over 2k is likely a too-broad prefix like "m1".
        const capped = set.size > MAX_CANDIDATES_PER_SERIAL
          ? new Set(Array.from(set).slice(0, MAX_CANDIDATES_PER_SERIAL))
          : set;
        serialShortlists.set(k, capped);
      }
      // Per-job memoization: each card is touched at most once for
      // the heavy work (build haystack + fold) — much cheaper than
      // recomputing for every serial key. We key on the card.key and
      // cache the folded haystack + the set of primary names.
      const jobMemo = new Map<number, { folded: string; primaries: Set<string>; customer: string }>();
      for (const { k, f } of serialKeys) {
        const sl = serialShortlists.get(k);
        if (!sl) continue;
        const e = perName.get(k)!;
        for (const cardKey of sl) {
          let memo = jobMemo.get(cardKey);
          if (!memo) {
            const card = this.byKey.get(cardKey);
            if (!card) continue;
            const primaries = new Set<string>();
            let rawHaystack = "";
            for (const d of card.devices) {
              const primary = cleanDeviceName(d.model, d.raw);
              if (primary) primaries.add(primary);
              if (typeof d.raw === "string" && d.raw.length > 0) {
                rawHaystack += " " + d.raw;
              }
            }
            if (!rawHaystack) {
              // Mark as "no haystack" with empty string so we don't
              // re-visit; the per-key check below will skip.
              memo = { folded: "", primaries, customer: (card.customer?.name ?? "").trim() };
            } else {
              memo = { folded: fold(rawHaystack), primaries, customer: (card.customer?.name ?? "").trim() };
            }
            jobMemo.set(cardKey, memo);
          }
          if (!memo.folded) continue;
          if (memo.primaries.has(k)) continue; // already counted in pass 1
          if (!memo.folded.includes(f)) continue;
          e.cmmsCount += 1;
          if (memo.customer) e.customerCounts.set(memo.customer, (e.customerCounts.get(memo.customer) ?? 0) + 1);
        }
      }
    }

    // Cross-DB counts: count rows in serviz_belso / szev_igeny /
    // telephely_munka that mention the cleaned device name. We use
    // the same fold() + LIKE pattern as related.ts so the numbers
    // match what find_related_tickets() would surface.
    //
    // Performance: in production the perName set can be 20k+ unique
    // device strings; running 3 LIKE-against-huge-table queries for
    // each one is 60k+ queries at startup. We skip the pass entirely
    // for keys with no cmms rows (the cross-DB-only case is rare —
    // most picker searches are for devices the operator has seen in
    // tickets) AND for keys the user is unlikely to search (model
    // names that already dominate the picker). The cross-DB count
    // for the displayed name then resolves lazily on the first
    // listDevices() hit; if a future operator searches for a
    // cross-DB-only device, listDevices() can fall back to a direct
    // SQL row scan instead of waiting for a full build.
    const dbs = this.dbs;
    const crossCounts = new Map<string, number>();
    if (dbs) {
      // Only cross-DB-scan the top-K by cmmsCount, so the user's
      // common searches resolve quickly. Rare serials still appear
      // with cmmsCount >= their true count; the cross-DB tail is
      // best-effort.
      const cmmsSorted = Array.from(perName.entries())
        .filter(([, e]) => e.cmmsCount > 0)
        .sort((a, b) => b[1].cmmsCount - a[1].cmmsCount)
        .slice(0, 1000);
      for (const [cleaned] of cmmsSorted) {
        const f = fold(cleaned);
        if (!f) continue;
        let n = 0;
        for (const [table, col, colAscii] of [
          ["serviz_belso", "eszkoz", "eszkoz_ascii"],
          ["szev_igeny", "geptipus", "geptipus_ascii"],
          ["telephely_munka", "geptipus", "geptipus_ascii"],
        ] as const) {
          if (!tableExists(dbs, table)) continue;
          try {
            // Prefer the fold-normalised ASCII column for case/diacritic
            // insensitivity; fall back to the raw column.
            const q = `SELECT COUNT(*) AS n FROM ${table} WHERE ${colAscii} LIKE ? OR ${col} LIKE ?`;
            const r = dbs.spec.query(q).get(`%${f}%`, `%${cleaned}%`) as { n: number } | null;
            n += r?.n ?? 0;
          } catch {
            // ignore
          }
        }
        crossCounts.set(cleaned, n);
      }
    }

    const out: DeviceIndexEntry[] = [];
    for (const [name, e] of perName) {
      out.push({
        name,
        cmmsCount: e.cmmsCount,
        crossCount: crossCounts.get(name) ?? 0,
        topCustomer: topCustomerFromCounts(e.customerCounts),
      });
    }
    this.deviceIndex = out;
    this.deviceCounts = new Map(out.map((d) => [d.name, d.cmmsCount]));
    this._deviceIndexFolded = null;
  }

  /** Substring device search for the machine-scope picker. Returns
   *  `{ name, tickets, customer_name }` sorted by total ticket count
   *  (cmms + cross-DB) desc, then name asc. Queries shorter than 2
   *  chars (after folding) return []. */
  listDevices(
    q: string,
    limit = 20,
  ): { name: string; tickets: number; customer_name: string | null }[] {
    const needle = (q ?? "").trim().toLowerCase().replace(/[-\s]/g, "");
    if (needle.length < 2) return [];
    if (!this.deviceIndex) this.buildDeviceCounts();
    const idx = this.deviceIndex!;
    // Build the per-name folded haystack on first read. 20k fold() calls
    // per request is the dominant cost — caching drops it to a single
    // includes() per name.
    if (!this._deviceIndexFolded) {
      this._deviceIndexFolded = new Map<string, string>();
      for (const d of idx) {
        this._deviceIndexFolded.set(d.name, d.name.toLowerCase().replace(/[-\s]/g, ""));
      }
    }
    const foldedMap = this._deviceIndexFolded;
    const out: { name: string; tickets: number; customer_name: string | null }[] = [];
    for (const d of idx) {
      const folded = foldedMap.get(d.name) ?? "";
      if (folded.includes(needle)) {
        out.push({
          name: d.name,
          tickets: d.cmmsCount + d.crossCount,
          customer_name: d.topCustomer,
        });
      }
    }
    out.sort(
      (a, b) => b.tickets - a.tickets || a.name.localeCompare(b.name),
    );
    return out.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Phase 5b: ticket-linkage index. Built during buildFromDb; lookups are
  // pure reads on the in-memory maps.
  // -------------------------------------------------------------------------

  /** Total number of sorszam cross-references in note bodies. */
  linkageTotal(): number {
    return this.linkage.total;
  }

  /** List of (from -> to) refs that mention `sorszam` as the target. */
  referencedBy(sorszam: string): LinkageRef[] {
    if (!this.linkage.forward.has(sorszam)) return [];
    return this.linkage.forward.get(sorszam)!.slice();
  }

  /** List of (from -> to) refs that `sorszam` itself makes. */
  referencesOf(sorszam: string): LinkageRef[] {
    if (!this.linkage.reverse.has(sorszam)) return [];
    return this.linkage.reverse.get(sorszam)!.slice();
  }

  /**
   * Top "hub" tickets — tickets that are mentioned by the most OTHER
   * tickets. Useful for the "melyik munkához jártunk ki a legtöbbször?"
   * question: the ticket with the highest indegree in the linkage graph
   * is a strong candidate for "the central work order of the period".
   *
   * @param opts.limit  max hubs to return (default 20)
   * @param opts.include_samples  attach up to N sample referencing tickets
   *                              so the LLM can cite real sorszams
   */
  topHubs(opts: { limit?: number; include_samples?: number } = {}): {
    sorszam: string;
    customer: string | null;
    machine: string | null;
    reported_at_iso: string | null;
    referenced_by_count: number;
    references_count: number;
    sample_referenced_by: string[];
  }[] {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const sampleN = Math.max(0, Math.min(10, opts.include_samples ?? 3));

    // Build [(sorszam, count), ...] from forward map.
    const hubs: { sorszam: string; count: number }[] = [];
    for (const [sorszam, refs] of this.linkage.forward) {
      if (refs.length === 0) continue;
      hubs.push({ sorszam, count: refs.length });
    }
    hubs.sort((a, b) => b.count - a.count);

    const out: ReturnType<typeof this.topHubs> = [];
    for (let i = 0; i < Math.min(limit, hubs.length); i++) {
      const { sorszam, count } = hubs[i];
      // Look up the JobCard so we can return customer + machine + date.
      let customer: string | null = null;
      let machine: string | null = null;
      let reported_at_iso: string | null = null;
      for (const c of this.byKey.values()) {
        if (c.sorszam === sorszam) {
          customer = c.customer.name || null;
          machine = c.devices[0]?.machine_type ?? null;
          reported_at_iso = c.reported_at_iso;
          break;
        }
      }
      const refs = this.linkage.forward.get(sorszam) ?? [];
      const reverseRefs = this.linkage.reverse.get(sorszam) ?? [];
      out.push({
        sorszam,
        customer,
        machine,
        reported_at_iso,
        referenced_by_count: count,
        references_count: reverseRefs.length,
        sample_referenced_by: sampleN > 0
          ? Array.from(new Set(refs.map((r) => r.from))).slice(0, sampleN)
          : [],
      });
    }
    return out;
  }

  /**
   * Aggregate tickets by a dimension with optional filters.
   * Returns sorted [{ name, count }] descending by count.
   */
  stats(opts: {
    group_by: "customer" | "device" | "technician" | "status" | "month" | "kategoria" | "sulyossag" | "machine_type" | "controller" | "kategoria_inferred" | "sulyossag_inferred" | "alkategoria_inferred" | "resolution";
    q?: string;
    customer?: string;
    device?: string;
    status?: "open" | "closed";
    date_from?: string;
    date_to?: string;
    kategoria?: string;
    sulyossag?: string;
    controller?: string;
    kategoria_inferred?: string;
    sulyossag_inferred?: string;
    alkategoria_inferred?: string;
    limit?: number;
  }): { name: string; count: number }[] {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    const qTokens = opts.q ? tokenize(opts.q) : [];
    const custF = opts.customer ? opts.customer.toLowerCase() : null;
    const devF = opts.device ? opts.device.toLowerCase() : null;
    const dateFrom = opts.date_from ?? null;
    const dateTo = opts.date_to ?? null;
    const katF = opts.kategoria ? opts.kategoria.toLowerCase() : null;
    const sulF = opts.sulyossag ? opts.sulyossag.toLowerCase() : null;
    const ctrlF = opts.controller ? opts.controller.toLowerCase() : null;
    // Phase 1 inferred filters
    const katInfF = opts.kategoria_inferred ? opts.kategoria_inferred.toLowerCase() : null;
    const sulInfF = opts.sulyossag_inferred ? opts.sulyossag_inferred.toLowerCase() : null;
    const alkInfF = opts.alkategoria_inferred ? opts.alkategoria_inferred.toLowerCase() : null;

    const counts = new Map<string, number>();

    for (const card of this.byKey.values()) {
      // Apply filters
      if (opts.status && card.status !== opts.status) continue;
      if (dateFrom && (!card.reported_at_iso || card.reported_at_iso < dateFrom)) continue;
      if (dateTo && (!card.reported_at_iso || card.reported_at_iso > dateTo)) continue;
      if (custF && !card.customer.name.toLowerCase().includes(custF)) continue;
      if (devF) {
        // Strip hyphens + spaces on BOTH sides so "M26057" matches
        // devices stored as "M-26057" or "M 26057". (M26057 case
        // where extractDevice returns "M26057" but device.raw has a
        // hyphenated form.)
        const devFolded = devF.replace(/[-\s]/g, "");
        const hit = card.devices.some((d) => {
          const m = d.model ? d.model.toLowerCase().replace(/[-\s]/g, "") : "";
          const r = d.raw.toLowerCase().replace(/[-\s]/g, "");
          return m.includes(devFolded) || r.includes(devFolded);
        });
        if (!hit) continue;
      }
      if (katF && (!card.problem_kategoria || !card.problem_kategoria.toLowerCase().includes(katF))) continue;
      if (sulF && (!card.sulyossag || !card.sulyossag.toLowerCase().includes(sulF))) continue;
      if (ctrlF) {
        const hit = card.devices.some((d) => d.controller && d.controller.toLowerCase().includes(ctrlF));
        if (!hit) continue;
      }
      if (katInfF && (!card.kategoria_inferred || !card.kategoria_inferred.toLowerCase().includes(katInfF))) continue;
      if (sulInfF && (!card.sulyossag_inferred || !card.sulyossag_inferred.toLowerCase().includes(sulInfF))) continue;
      if (alkInfF && (!card.alkategoria_inferred || !card.alkategoria_inferred.toLowerCase().includes(alkInfF))) continue;
      if (qTokens.length > 0) {
        const allHit = qTokens.every((t) => card._haystack.includes(t));
        if (!allHit) continue;
      }

      // Group by dimension
      switch (opts.group_by) {
        case "customer":
          counts.set(card.customer.name, (counts.get(card.customer.name) ?? 0) + 1);
          break;
        case "device":
          for (const d of card.devices) {
            const name = d.model || d.raw;
            counts.set(name, (counts.get(name) ?? 0) + 1);
          }
          break;
        case "machine_type":
          for (const d of card.devices) {
            const name = d.machine_type ?? "(nincs megadva)";
            counts.set(name, (counts.get(name) ?? 0) + 1);
          }
          break;
        case "controller":
          for (const d of card.devices) {
            const name = d.controller ?? "(nincs vezerlo)";
            counts.set(name, (counts.get(name) ?? 0) + 1);
          }
          break;
        case "technician":
          if (card.technician) {
            counts.set(card.technician, (counts.get(card.technician) ?? 0) + 1);
          }
          break;
        case "status":
          counts.set(card.status, (counts.get(card.status) ?? 0) + 1);
          break;
        case "month": {
          const m = card.reported_at_iso?.slice(0, 7) ?? "unknown";
          counts.set(m, (counts.get(m) ?? 0) + 1);
          break;
        }
        case "kategoria":
          counts.set(card.problem_kategoria ?? "(nincs besorolva)", (counts.get(card.problem_kategoria ?? "(nincs besorolva)") ?? 0) + 1);
          break;
        case "sulyossag":
          counts.set(card.sulyossag ?? "(nincs megadva)", (counts.get(card.sulyossag ?? "(nincs megadva)") ?? 0) + 1);
          break;
        case "kategoria_inferred":
          counts.set(card.kategoria_inferred ?? "(nincs besorolva)", (counts.get(card.kategoria_inferred ?? "(nincs besorolva)") ?? 0) + 1);
          break;
        case "sulyossag_inferred":
          counts.set(card.sulyossag_inferred ?? "(nincs megadva)", (counts.get(card.sulyossag_inferred ?? "(nincs megadva)") ?? 0) + 1);
          break;
        case "alkategoria_inferred":
          counts.set(card.alkategoria_inferred ?? "(nincs megadva)", (counts.get(card.alkategoria_inferred ?? "(nincs megadva)") ?? 0) + 1);
          break;
        case "resolution":
          counts.set(card.resolution ?? card.status, (counts.get(card.resolution ?? card.status) ?? 0) + 1);
          break;
      }
    }

    return topN(counts, limit);
  }

  /**
   * Return up to `limit` sample JobCards that fall into a specific
   * group (e.g. "all tickets whose customer name is 'ANDRITZ KFT.'"),
   * using the same filter semantics as `stats()`.
   *
   * Used by /v1/jobs/stats to attach evidence (sorszam + a short
   * snippet of the reported/work text) to each top-N group. The LLM
   * (and the human) can cite a real ticket instead of trusting the
   * count blindly.
   */
  sampleTickets(opts: {
    q?: string;
    customer?: string;
    device?: string;
    status?: "open" | "closed";
    date_from?: string;
    date_to?: string;
    kategoria?: string;
    sulyossag?: string;
    controller?: string;
    kategoria_inferred?: string;
    sulyossag_inferred?: string;
    alkategoria_inferred?: string;
    /** The group value to match, e.g. "ANDRITZ KFT." or "TMV-400". */
    group_by?: string;
    group_by_field?: "customer" | "device" | "technician" | "status" | "month" | "kategoria" | "sulyossag" | "machine_type" | "controller" | "kategoria_inferred" | "sulyossag_inferred" | "alkategoria_inferred" | "resolution";
    limit?: number;
  }): { sorszam: string; key: number; reported_at_iso: string | null; snippet: string; kategoria: string | null; kategoria_inferred: string | null; sulyossag_inferred: string | null }[] {
    const limit = Math.max(0, Math.min(5, opts.limit ?? 2));
    if (limit === 0 || !opts.group_by || !opts.group_by_field) return [];
    const qTokens = opts.q ? tokenize(opts.q) : [];
    const custF = opts.customer ? opts.customer.toLowerCase() : null;
    const devF = opts.device ? opts.device.toLowerCase() : null;
    const dateFrom = opts.date_from ?? null;
    const dateTo = opts.date_to ?? null;
    const katF = opts.kategoria ? opts.kategoria.toLowerCase() : null;
    const sulF = opts.sulyossag ? opts.sulyossag.toLowerCase() : null;
    const ctrlF = opts.controller ? opts.controller.toLowerCase() : null;
    const groupName = opts.group_by;

    const out: { sorszam: string; key: number; reported_at_iso: string | null; snippet: string; kategoria: string | null; kategoria_inferred: string | null; sulyossag_inferred: string | null }[] = [];
    for (const card of this.byKey.values()) {
      if (out.length >= limit) break;
      // Apply the standard filters.
      if (opts.status && card.status !== opts.status) continue;
      if (dateFrom && (!card.reported_at_iso || card.reported_at_iso < dateFrom)) continue;
      if (dateTo && (!card.reported_at_iso || card.reported_at_iso > dateTo)) continue;
      if (custF && !card.customer.name.toLowerCase().includes(custF)) continue;
      if (devF) {
        // Strip hyphens + spaces on BOTH sides so "M26057" matches
        // devices stored as "M-26057" or "M 26057". (M26057 case
        // where extractDevice returns "M26057" but device.raw has a
        // hyphenated form.)
        const devFolded = devF.replace(/[-\s]/g, "");
        const hit = card.devices.some((d) => {
          const m = d.model ? d.model.toLowerCase().replace(/[-\s]/g, "") : "";
          const r = d.raw.toLowerCase().replace(/[-\s]/g, "");
          return m.includes(devFolded) || r.includes(devFolded);
        });
        if (!hit) continue;
      }
      if (katF && (!card.problem_kategoria || !card.problem_kategoria.toLowerCase().includes(katF))) continue;
      if (sulF && (!card.sulyossag || !card.sulyossag.toLowerCase().includes(sulF))) continue;
      const katInfF = opts.kategoria_inferred ? opts.kategoria_inferred.toLowerCase() : null;
      const sulInfF = opts.sulyossag_inferred ? opts.sulyossag_inferred.toLowerCase() : null;
      const alkInfF = opts.alkategoria_inferred ? opts.alkategoria_inferred.toLowerCase() : null;
      if (katInfF && (!card.kategoria_inferred || !card.kategoria_inferred.toLowerCase().includes(katInfF))) continue;
      if (sulInfF && (!card.sulyossag_inferred || card.sulyossag_inferred.toLowerCase() !== sulInfF)) continue;
      if (alkInfF && (!card.alkategoria_inferred || !card.alkategoria_inferred.toLowerCase().includes(alkInfF))) continue;
      if (ctrlF) {
        const hit = card.devices.some((d) => d.controller && d.controller.toLowerCase().includes(ctrlF));
        if (!hit) continue;
      }
      if (qTokens.length > 0) {
        const allHit = qTokens.every((t) => card._haystack.includes(t));
        if (!allHit) continue;
      }
      // Match the group value.
      const groupValue = this.groupValueOf(card, opts.group_by_field);
      if (groupValue !== groupName) continue;

      // Pick the most informative note as the snippet.
      const reported = card.notes.find((n) => n.kind === "reported");
      const work = card.notes.find((n) => n.kind === "work");
      const free = card.notes.find((n) => n.kind === "free");
      const pick = (reported && reported.body) || (work && work.body) || (free && free.body) || "";
      const snippet = pick.length > 160 ? pick.slice(0, 157) + "..." : pick;
      out.push({
        sorszam: card.sorszam,
        key: card.key,
        reported_at_iso: card.reported_at_iso,
        snippet,
        kategoria: card.problem_kategoria,
        kategoria_inferred: card.kategoria_inferred,
        sulyossag_inferred: card.sulyossag_inferred,
      });
    }
    // Newest first for the most useful evidence.
    out.sort((a, b) => (b.reported_at_iso ?? "").localeCompare(a.reported_at_iso ?? ""));
    return out;
  }

  /** Extract the same group string for a card that `stats()` would emit. */
  private groupValueOf(
    card: JobCard,
    field: "customer" | "device" | "technician" | "status" | "month" | "kategoria" | "sulyossag" | "machine_type" | "controller" | "kategoria_inferred" | "sulyossag_inferred" | "alkategoria_inferred" | "resolution",
  ): string | null {
    switch (field) {
      case "customer":     return card.customer.name;
      case "device": {
        // The first device with a model wins; falls back to raw.
        const d = card.devices.find((x) => x.model) ?? card.devices[0];
        return d ? (d.model ?? d.raw) : null;
      }
      case "machine_type": {
        const d = card.devices.find((x) => x.machine_type);
        return d?.machine_type ?? null;
      }
      case "controller": {
        const d = card.devices.find((x) => x.controller);
        return d?.controller ?? null;
      }
      case "technician":   return card.technician ?? null;
      case "status":       return card.status;
      case "month":        return card.reported_at_iso?.slice(0, 7) ?? null;
      case "kategoria":    return card.problem_kategoria;
      case "sulyossag":    return card.sulyossag;
      case "kategoria_inferred":    return card.kategoria_inferred;
      case "sulyossag_inferred":    return card.sulyossag_inferred;
      case "alkategoria_inferred":  return card.alkategoria_inferred;
      case "resolution":            return card.resolution;
      default:             return null;
    }
  }

  /**
   * Returns the next sorszam for the current year-month. We compute it
   * from the in-memory cache (all known sorszams) plus, as a fallback, a
   * direct read of the spec DB file. The fallback exists for the first
   * call after startup, before any local appends.
   *
   * The reason we don't use a plain `dbs.spec.query` for the live count
   * is that the long-lived writer connection has been observed to return
   * a stale snapshot for SELECT after a write transaction commits, on
   * some platforms / filesystem configurations. Computing the next
   * sorszam from the in-memory cache avoids the problem entirely.
   */
  nextSorszamForThisMonth(specPath: string, now: Date = new Date()): string {
    const y = now.getFullYear();
    const m = (now.getMonth() + 1).toString().padStart(2, "0");
    const yy = (y % 100).toString().padStart(2, "0");
    const prefix = `B${yy}${m}`;
    let maxSeq = 0;
    for (const card of this.byKey.values()) {
      if (card.sorszam && card.sorszam.startsWith(prefix)) {
        const tail = card.sorszam.slice(prefix.length);
        const n = parseInt(tail, 10);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      }
    }
    // First call: no jobs in cache yet. Read the spec DB file once.
    if (maxSeq === 0) {
      try {
        // Dynamic import to keep bun:sqlite out of the cache module's top
        // level for any future platform that swaps the driver.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
        const db = new Database(specPath, { readonly: true });
        try {
          const rows = db.prepare(`SELECT sorszam FROM jobs`).all() as { sorszam: string }[];
          for (const r of rows) {
            if (r.sorszam && r.sorszam.startsWith(prefix)) {
              const tail = r.sorszam.slice(prefix.length);
              const n = parseInt(tail, 10);
              if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
            }
          }
        } finally {
          db.close();
        }
      } catch {
        // ignore; will return 001
      }
    }
    return `${prefix}${(maxSeq + 1).toString().padStart(3, "0")}`;
  }

  /**
   * Search.
   * - q: AND of tokens against _haystack (diacritic-folded, lowercased).
   * - customer: substring (folded) against customer.name.
   * - device: substring (folded) against any device.raw or device.model.
   * - status: 'open' | 'closed'.
   * - date_from / date_to: YYYY-MM-DD range on reported_at_iso.
   * - notes_contains: substring (folded) against note bodies.
   * - kategoria: substring (folded) against problem_kategoria.
   * - sulyossag: exact match on sulyossag.
   * - offset / limit: pagination.
   * - fields: project JobCard to only requested fields.
   */
  search(opts: {
    q?: string;
    customer?: string;
    device?: string;
    status?: "open" | "closed";
    date_from?: string;
    date_to?: string;
    notes_contains?: string;
    kategoria?: string;
    sulyossag?: string;
    controller?: string;
    // Phase 1 inferred filters
    kategoria_inferred?: string;
    sulyossag_inferred?: string;
    alkategoria_inferred?: string;
    limit?: number;
    offset?: number;
    fields?: string[];
  }): SearchResult {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const offset = Math.max(0, opts.offset ?? 0);
    const qTokens = opts.q ? tokenize(opts.q) : [];
    // Phase 5c: auto-detect an M-serial machine identifier inside `q`
    // (e.g. "M09192" or "X tengely golyós orsó csapágyak M09192 munkánál")
    // and promote it to a device filter. Without this, "M09192" is just
    // an arbitrary token in q, gets ANDed with the rest of the prose,
    // and a question like "M09192 munkánál" lands on a sorszam-shaped
    // search that returns 0 because no sorszam starts with M.
    let devFromQ: string | null = null;
    if (qTokens.length > 0) {
      for (const t of qTokens) {
        const m = t.match(/^m\d{4,6}$/);
        if (m) { devFromQ = t.toUpperCase().replace(/[-\s]+/g, "-"); break; }
      }
    }
    const effectiveDevice = opts.device || devFromQ || undefined;
    const custF = opts.customer ? opts.customer.toLowerCase() : null;
    const devF = effectiveDevice ? effectiveDevice.toLowerCase() : null;
    // When a device filter (explicit or auto-extracted) is in effect, the
    // q prose is descriptive context (e.g. "X tengely golyós orsó
    // csapágyak típusa"). The cache used to require ALL q tokens to
    // appear in the haystack (AND-of-tokens), which rejects the right
    // result when the user asks about specs not literally written in
    // the device's notes. Now we score q-tokens as a soft boost on top
    // of the device filter. A bare q (no device) still uses the strict
    // AND.
    const softQ = !!effectiveDevice;
    const dateFrom = opts.date_from ?? null;
    const dateTo = opts.date_to ?? null;
    const notesF = opts.notes_contains ? fold(opts.notes_contains) : null;
    const katF = opts.kategoria ? opts.kategoria.toLowerCase() : null;
    const sulF = opts.sulyossag ? opts.sulyossag.toLowerCase() : null;
    const ctrlF = opts.controller ? opts.controller.toLowerCase() : null;
    // Phase 1 inferred filter normalization
    const katInfF = opts.kategoria_inferred ? opts.kategoria_inferred.toLowerCase() : null;
    const sulInfF = opts.sulyossag_inferred ? opts.sulyossag_inferred.toLowerCase() : null;
    const alkInfF = opts.alkategoria_inferred ? opts.alkategoria_inferred.toLowerCase() : null;

    // Use the prefix index to short-circuit when ALL query tokens are
    // known to map to a non-empty set. If any token's prefix is missing
    // from the index, we cannot conclude that nothing matches (the
    // token might match against notes, customer name, or address — none
    // of which are in the prefix index). In that case we fall back to
    // scanning all keys.
    let candidates: Set<number> | null = null;
    if (qTokens.length > 0) {
      let useIndex = true;
      for (const t of qTokens) {
        const set = this.prefixIndex.get(t.slice(0, Math.min(t.length, 5)));
        if (!set) {
          useIndex = false;
          break;
        }
        if (candidates == null) {
          candidates = new Set(set);
        } else {
          for (const k of [...candidates]) {
            if (!set.has(k)) candidates.delete(k);
          }
        }
        if (candidates.size === 0) break;
      }
      if (!useIndex) candidates = null;
    }

    const pool: Iterable<number> = candidates ?? this.byKey.keys();
    const out: SearchHit[] = [];
    for (const key of pool) {
      const card = this.byKey.get(key);
      if (!card) continue;
      if (opts.status && card.status !== opts.status) continue;
      if (dateFrom && (!card.reported_at_iso || card.reported_at_iso < dateFrom)) continue;
      if (dateTo && (!card.reported_at_iso || card.reported_at_iso > dateTo)) continue;
      if (custF && !card.customer.name.toLowerCase().includes(custF)) continue;
      if (devF) {
        // Strip hyphens + spaces on BOTH sides so "M26057" matches
        // devices stored as "M-26057" or "M 26057". (M26057 case
        // where extractDevice returns "M26057" but device.raw has a
        // hyphenated form.)
        const devFolded = devF.replace(/[-\s]/g, "");
        const hit = card.devices.some((d) => {
          const m = d.model ? d.model.toLowerCase().replace(/[-\s]/g, "") : "";
          const r = d.raw.toLowerCase().replace(/[-\s]/g, "");
          return m.includes(devFolded) || r.includes(devFolded);
        });
        if (!hit) continue;
      }
      if (notesF) {
        const hit = card.notes.some((n) => fold(n.body).includes(notesF));
        if (!hit) continue;
      }
      if (katF && (!card.problem_kategoria || !card.problem_kategoria.toLowerCase().includes(katF))) continue;
      if (sulF && (!card.sulyossag || card.sulyossag.toLowerCase() !== sulF)) continue;
      if (ctrlF) {
        const hit = card.devices.some((d) => d.controller && d.controller.toLowerCase().includes(ctrlF));
        if (!hit) continue;
      }
      // Phase 1 inferred filters
      if (katInfF && (!card.kategoria_inferred || !card.kategoria_inferred.toLowerCase().includes(katInfF))) continue;
      if (sulInfF && (!card.sulyossag_inferred || card.sulyossag_inferred.toLowerCase() !== sulInfF)) continue;
      if (alkInfF && (!card.alkategoria_inferred || !card.alkategoria_inferred.toLowerCase().includes(alkInfF))) continue;
      let score = 0;
      if (qTokens.length > 0) {
        // Phase 5c: when softQ is on (device filter present), q-tokens
        // become a soft scoring boost — we don't require all to match.
        // Without a device filter we keep the strict AND behavior so
        // free-text searches still narrow the result set.
        if (!softQ) {
          let allHit = true;
          for (const t of qTokens) {
            if (card._haystack.includes(t)) {
              score += 1;
            } else {
              allHit = false;
              break;
            }
          }
          if (!allHit) continue;
        }
        // Bonus for matches in the three priority fields.
        for (const t of qTokens) {
          if (!card._haystack.includes(t)) continue; // softQ: missing token gets 0
          score += 1;
          for (const d of card.devices) {
            if ((d.model && d.model.toLowerCase().includes(t)) || d.raw.toLowerCase().includes(t)) {
              score += 3;
            }
          }
          for (const n of card.notes) {
            if (n.body.toLowerCase().includes(t)) score += 2;
          }
          if (card.customer.name.toLowerCase().includes(t)) score += 1;
        }
      }
      out.push({ job: card, score });
    }

    out.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.job.key - a.job.key;
    });

    const total = out.length;
    const sliced = out.slice(offset, offset + limit);

    if (opts.fields && opts.fields.length > 0) {
      for (const hit of sliced) {
        hit.job = projectCard(hit.job, opts.fields) as JobCard;
      }
    }

    return { hits: sliced, total };
  }

  /**
   * Find recurring problems — groups of 2+ tickets sharing a root-cause
   * signature. Used by find_recurring_problems MCP tool and the
   * recurring_problem group_by in get_ticket_stats.
   */
  recurringProblems(opts: {
    customer?: string;
    machine?: string;
    controller?: string;
    software?: string;
    hardware?: string;
    kategoria?: string;
    alkategoria?: string;
    date_from?: string;
    date_to?: string;
    scope: "narrow" | "broad" | "broadest";
    min_visits?: number;
    limit?: number;
  }): { clusters: ProblemCluster[]; total: number; scope: Scope; min_visits: number } {
    const t0 = performance.now();
    const scope = opts.scope;
    const min_visits = Math.max(2, opts.min_visits ?? 2);
    const limit = Math.max(1, Math.min(500, opts.limit ?? 20));
    const filter: SignatureFilter = {
      customer: opts.customer,
      machine: opts.machine,
      controller: opts.controller,
      software: opts.software,
      hardware: opts.hardware,
      kategoria: opts.kategoria,
      alkategoria: opts.alkategoria,
    };
    const dateFrom = opts.date_from ?? null;
    const dateTo = opts.date_to ?? null;

    // Pre-filter: apply filter and date range up front, drop tickets
    // with no signature fields at all.
    const eligible: JobCard[] = [];
    for (const card of this.byKey.values()) {
      if (!matchesDateFilter(card.reported_at_iso, dateFrom, dateTo)) continue;
      const sig = ticketSignature(card);
      if (!matchesFilter(sig, filter)) continue;
      eligible.push(card);
    }

    const buckets = bucketByClusterKey(eligible, scope);
    const all = buildClusterSummaries(buckets, scope);
    const clusters = all.filter((c) => c.visit_count >= min_visits).slice(0, limit);
    const elapsed = Math.round(performance.now() - t0);
    if (elapsed > 200) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ t: new Date().toISOString(), msg: "recurringProblems_slow", elapsed_ms: elapsed, eligible: eligible.length, buckets: buckets.size, clusters: clusters.length }));
    }
    return { clusters, total: all.length, scope, min_visits };
  }

  /**
   * Get the full ordered ticket list for a single cluster, identified by
   * the same signature fields used to build it.
   */
  problemCluster(opts: {
    customer?: string;
    machine?: string;
    controller?: string;
    software?: string;
    hardware?: string;
    kategoria?: string;
    alkategoria?: string;
    date_from?: string;
    date_to?: string;
    scope: "narrow" | "broad" | "broadest";
    limit?: number;
  }): { signature: SignatureFilter; cluster: ProblemCluster; tickets: JobCard[] } | null {
    const scope = opts.scope;
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    const filter: SignatureFilter = {
      customer: opts.customer,
      machine: opts.machine,
      controller: opts.controller,
      software: opts.software,
      hardware: opts.hardware,
      kategoria: opts.kategoria,
      alkategoria: opts.alkategoria,
    };
    const dateFrom = opts.date_from ?? null;
    const dateTo = opts.date_to ?? null;

    const eligible: JobCard[] = [];
    for (const card of this.byKey.values()) {
      if (!matchesDateFilter(card.reported_at_iso, dateFrom, dateTo)) continue;
      const sig = ticketSignature(card);
      if (!matchesFilter(sig, filter)) continue;
      eligible.push(card);
    }
    const buckets = bucketByClusterKey(eligible, scope);
    // We want the bucket that exactly matches all the filter fields.
    // Walk the buckets and find the one whose tickets all have signature
    // fields equal to the filter (when filter has a value).
    for (const [, tickets] of buckets) {
      if (tickets.length < 2) continue;
      const active = activeFields(tickets);
      // The returned cluster is the one whose active fields match the filter
      // (or whose active fields are a strict subset).
      let match = true;
      for (const k of Object.keys(filter) as (keyof SignatureFilter)[]) {
        const want = filter[k];
        if (!want) continue;
        if (fold(active[k] ?? "") !== fold(want)) { match = false; break; }
      }
      if (!match) continue;
      // Use the filter as the canonical signature (not active fields) when
      // the filter is provided — the filter is the user's explicit ask.
      const cluster = summarizeCluster(
        buildClusterKey({ ...active, ...filter }, scope),
        tickets,
        { ...active, ...filter },
      );
      return { signature: cluster.signature, cluster, tickets: tickets.slice(0, limit) };
    }
    return null;
  }
}

export function projectCard(card: JobCard, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const customerFields = new Set<string>();
  const hasCustomer = fields.some((f) => {
    if (f === "customer") return true;
    if (f.startsWith("customer.")) {
      customerFields.add(f.slice("customer.".length));
      return true;
    }
    return false;
  });

  for (const f of fields) {
    if (f === "key") out.key = card.key;
    else if (f === "sorszam") out.sorszam = card.sorszam;
    else if (f === "reported_at") out.reported_at = card.reported_at;
    else if (f === "reported_at_iso") out.reported_at_iso = card.reported_at_iso;
    else if (f === "status") out.status = card.status;
    else if (f === "technician") out.technician = card.technician;
    else if (f === "problem_kategoria") out.problem_kategoria = card.problem_kategoria;
    else if (f === "problem_alkategoria") out.problem_alkategoria = card.problem_alkategoria;
    else if (f === "sulyossag") out.sulyossag = card.sulyossag;
    else if (f === "customer") out.customer = card.customer;
    else if (f === "devices") out.devices = card.devices;
    else if (f === "devices_summary") {
      out.devices = card.devices.map((d) => ({ raw: d.raw, model: d.model }));
    } else if (f === "notes") out.notes = card.notes;
    else if (f === "notes_summary") {
      out.notes = card.notes.map((n) => ({
        kind: n.kind,
        body: n.body.length > 200 ? n.body.slice(0, 200) + "…" : n.body,
      }));
    }
  }

  if (hasCustomer && !out.customer) {
    if (customerFields.size === 0) {
      out.customer = card.customer;
    } else {
      const c: Record<string, unknown> = {};
      for (const sf of customerFields) {
        if (sf in card.customer) c[sf] = (card.customer as Record<string, unknown>)[sf];
      }
      out.customer = c;
    }
  }

  return out;
}

function buildHaystack(card: JobCard): string {
  // Diacritic-fold + lowercase so that a folded ASCII query (e.g.
  // "keszulek") matches Hungarian source text (e.g. "készülék").
  return fold(
    [
      card.customer.name,
      card.customer.address,
      ...card.devices.flatMap((d) => [
        d.raw,
        d.model,
        d.software,
        d.hardware,
        d.servos,
        d.freeform,
      ]),
      ...card.notes.map((n) => n.body),
      card.technician,
      card.problem_kategoria,
      card.problem_alkategoria,
      card.sulyossag,
    ]
      .filter((s): s is string => !!s)
      .join(" "),
  );
}

function topN(m: Map<string, number>, n: number): { name: string; count: number }[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}
