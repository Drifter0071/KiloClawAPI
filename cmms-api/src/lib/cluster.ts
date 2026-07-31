// Problem-cluster analytics.
//
// A "problem" is identified by a signature tuple of (customer?, machine?,
// controller?, software?, hardware?, kategoria?, alkategoria?). Two tickets
// share a cluster when all ACTIVE fields agree.
//
// "Active" fields are decided after the fact: a field is active only if
// every ticket in the cluster agrees on its value. If even one ticket
// disagrees, the field is dropped from the signature.
//
// Scope controls which fields are USED to BUILD the cluster key:
//   - narrow:    all 7 fields are part of the key
//   - broad:     only machine, controller, kategoria are part of the key
//   - broadest:  only controller and kategoria are part of the key
//
// Once tickets are grouped, we still report which fields are active in the
// returned signature (so the LLM can see "this cluster has a unanimous
// machine=TMV-400 even though it wasn't used to build the key").

import type { JobCard, Note } from "../cache/jobs";
import { fold } from "../db/parse";

export type SignatureField =
  | "customer"
  | "machine"
  | "controller"
  | "software"
  | "hardware"
  | "kategoria"
  | "alkategoria";

export type SignatureFilter = {
  customer?: string;
  machine?: string;
  controller?: string;
  software?: string;
  hardware?: string;
  kategoria?: string;
  alkategoria?: string;
};

export type Scope = "narrow" | "broad" | "broadest";

export type Handoff = {
  from: string;
  to: string;
  ticket_key: number;
  date: string;
};

export type ProblemCluster = {
  cluster_key: string;
  signature: SignatureFilter;
  ticket_count: number;
  visit_count: number;
  technicians: string[];
  first_seen: string;
  last_seen: string;
  span_days: number;
  avg_gap_days: number;
  handoffs: Handoff[];
};

// ---------------------------------------------------------------------------
// Visit-line detection (shared with effort scoring).
// ---------------------------------------------------------------------------

const VISIT_PATTERNS: RegExp[] = [
  /^--\s+\d{4}[-.]\d{2}[-.]\d{2}/m,
  /^\d{4}[-.]\d{2}[-.]\d{2}\s+[A-ZÁÉÍÓÖŐÚÜŰ]/m,
  /^Dátum:\s*\d{4}[-.]\d{2}[-.]\d{2}/im,
  /^Időpont:\s*\d{4}[-.]\d{2}[-.]\d{2}/im,
  /^\d{1,2}\.\s*kiszállás/im,
  /\bvisszament(?:em|ünk)\b/i,
  /\bismételt\b/i,
];

export function countVisits(notes: Note[]): number {
  // Visit count = number of matching patterns across all note bodies,
  // falling back to notes.length (each note = at least one visit).
  const allBodies = notes.map((n) => n.body ?? "").join("\n");
  let visits = 0;
  for (const re of VISIT_PATTERNS) {
    const matches = allBodies.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
    if (matches) visits += matches.length;
  }
  // De-duplicate per body: if multiple regexes match the same line,
  // we don't want to double-count. For simplicity, take the max.
  if (visits === 0) return Math.max(1, notes.length);
  return Math.max(visits, notes.length);
}

// ---------------------------------------------------------------------------
// Per-ticket signature extraction.
// ---------------------------------------------------------------------------

export function ticketSignature(card: JobCard): SignatureFilter {
  // Pick the first device for machine/controller/software/hardware.
  // (The plan documents this: tickets with multiple devices are placed
  // into clusters by their primary device only.)
  const d = card.devices[0];
  return {
    customer: card.customer.name || undefined,
    machine: d?.machine_type ?? undefined,
    controller: d?.controller ?? undefined,
    software: d?.software ?? undefined,
    hardware: d?.hardware ?? undefined,
    kategoria: card.problem_kategoria ?? undefined,
    alkategoria: card.problem_alkategoria ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Filtering.
// ---------------------------------------------------------------------------

export function matchesFilter(sig: SignatureFilter, filter: SignatureFilter): boolean {
  for (const key of Object.keys(filter) as (keyof SignatureFilter)[]) {
    const want = filter[key];
    if (!want) continue;
    const have = sig[key];
    if (!have) return false;
    if (fold(have) !== fold(want)) return false;
  }
  return true;
}

export function matchesDateFilter(
  date_iso: string | null,
  date_from: string | null,
  date_to: string | null,
): boolean {
  if (!date_iso) return !date_from && !date_to;
  if (date_from && date_iso < date_from) return false;
  if (date_to && date_iso > date_to) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Cluster key construction.
// ---------------------------------------------------------------------------

function keyFieldsForScope(scope: Scope): (keyof SignatureFilter)[] {
  if (scope === "narrow") {
    return ["customer", "machine", "controller", "software", "hardware", "kategoria", "alkategoria"];
  }
  if (scope === "broad") {
    return ["machine", "controller", "kategoria"];
  }
  return ["controller", "kategoria"];
}

export function buildClusterKey(sig: SignatureFilter, scope: Scope): string {
  const fields = keyFieldsForScope(scope);
  const parts: string[] = [];
  for (const f of fields) {
    parts.push(`${f}=${fold(sig[f] ?? "")}`);
  }
  return parts.join("|");
}

// ---------------------------------------------------------------------------
// Active-field resolution.
// ---------------------------------------------------------------------------

export function activeFields(tickets: JobCard[]): SignatureFilter {
  if (tickets.length === 0) return {};
  const allFields: (keyof SignatureFilter)[] = [
    "customer",
    "machine",
    "controller",
    "software",
    "hardware",
    "kategoria",
    "alkategoria",
  ];
  const result: SignatureFilter = {};
  for (const f of allFields) {
    const values = new Set<string>();
    for (const t of tickets) {
      const sig = ticketSignature(t);
      const v = sig[f];
      if (v) values.add(fold(v));
    }
    if (values.size === 1) {
      // Find the original (non-folded) value from the first ticket that has it.
      for (const t of tickets) {
        const sig = ticketSignature(t);
        if (sig[f]) {
          (result as Record<string, string | undefined>)[f] = sig[f];
          break;
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Handoff detection.
// ---------------------------------------------------------------------------

export function detectHandoffs(tickets: JobCard[]): Handoff[] {
  // Tickets must already be ordered by date.
  const handoffs: Handoff[] = [];
  for (let i = 1; i < tickets.length; i++) {
    const prev = tickets[i - 1];
    const curr = tickets[i];
    const prevTech = prev.technician?.trim() || "";
    const currTech = curr.technician?.trim() || "";
    if (!prevTech || !currTech) continue;
    if (prevTech === currTech) continue;
    if (!curr.reported_at_iso) continue;
    handoffs.push({
      from: prevTech,
      to: currTech,
      ticket_key: curr.key,
      date: curr.reported_at_iso,
    });
  }
  return handoffs;
}

// ---------------------------------------------------------------------------
// Cluster summary.
// ---------------------------------------------------------------------------

export function summarizeCluster(
  clusterKey: string,
  tickets: JobCard[],
  activeSig: SignatureFilter,
): ProblemCluster {
  const sorted = [...tickets].sort((a, b) => {
    const aDate = a.reported_at_iso ?? "";
    const bDate = b.reported_at_iso ?? "";
    if (aDate < bDate) return -1;
    if (aDate > bDate) return 1;
    return a.key - b.key;
  });

  const techs = new Set<string>();
  let totalVisits = 0;
  for (const t of sorted) {
    if (t.technician?.trim()) techs.add(t.technician.trim());
    totalVisits += t._visit_count ?? 1;
  }

  const dates = sorted
    .map((t) => t.reported_at_iso)
    .filter((d): d is string => !!d)
    .sort();
  const first_seen = dates[0] ?? "";
  const last_seen = dates[dates.length - 1] ?? "";

  const span_days = first_seen && last_seen
    ? Math.max(0, Math.floor((Date.parse(last_seen) - Date.parse(first_seen)) / 86_400_000))
    : 0;
  const avg_gap_days = sorted.length > 1 && span_days > 0
    ? Math.round((span_days / (sorted.length - 1)) * 10) / 10
    : 0;

  return {
    cluster_key: clusterKey,
    signature: activeSig,
    ticket_count: sorted.length,
    visit_count: totalVisits,
    technicians: [...techs].sort(),
    first_seen,
    last_seen,
    span_days,
    avg_gap_days,
    handoffs: detectHandoffs(sorted),
  };
}

// ---------------------------------------------------------------------------
// Bucket and cluster tickets.
// ---------------------------------------------------------------------------

export function bucketByClusterKey(
  tickets: JobCard[],
  scope: Scope,
): Map<string, JobCard[]> {
  const buckets = new Map<string, JobCard[]>();
  for (const t of tickets) {
    const sig = ticketSignature(t);
    const key = buildClusterKey(sig, scope);
    if (key === "") continue;
    const arr = buckets.get(key) ?? [];
    arr.push(t);
    buckets.set(key, arr);
  }
  return buckets;
}

export function buildClusterSummaries(
  buckets: Map<string, JobCard[]>,
  scope: Scope,
): ProblemCluster[] {
  const clusters: ProblemCluster[] = [];
  for (const [key, tickets] of buckets.entries()) {
    if (tickets.length < 2) continue; // clusters need >= 2 tickets to be a "recurring problem"
    const active = activeFields(tickets);
    clusters.push(summarizeCluster(key, tickets, active));
  }
  // Sort by visit_count desc, then last_seen desc, then first_seen desc.
  clusters.sort((a, b) => {
    if (b.visit_count !== a.visit_count) return b.visit_count - a.visit_count;
    if (b.last_seen !== a.last_seen) return b.last_seen.localeCompare(a.last_seen);
    return b.first_seen.localeCompare(a.first_seen);
  });
  return clusters;
}
