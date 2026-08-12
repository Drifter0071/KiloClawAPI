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

export class JobCache {
  private static _nextId = 0;
  private _id: number = ++JobCache._nextId;
  private byKey: Map<number, JobCard> = new Map();
  private prefixIndex: Map<string, Set<number>> = new Map();
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

  get(key: number): JobCard | undefined {
    return this.byKey.get(key);
  }

  delete(key: number): boolean {
    const card = this.byKey.get(key);
    if (!card) return false;
    this.byKey.delete(key);
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
    const custF = opts.customer ? opts.customer.toLowerCase() : null;
    const devF = opts.device ? opts.device.toLowerCase() : null;
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
        // Bonus for matches in the three priority fields.
        for (const t of qTokens) {
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
