// Shared utilities for job/ticket operations.
// Extracted from jobs.ts so tickets.ts can reuse them.

import type { OpenDbs } from "../db/open";
import type { JobCard, Note } from "../cache/jobs";

/**
 * Rebuild a full JobCard from the specialized DB for a given key.
 * Used after any write to return the updated state to the caller.
 */
export function makeCardFromSpec(dbs: OpenDbs, key: number): JobCard {
  const job = dbs.spec
    .prepare(
      `SELECT key, sorszam, reported_at, reported_at_iso, customer_id, technician, status,
              problem_kategoria, problem_alkategoria, sulyossag
       FROM jobs WHERE key = ?`,
    )
    .get(key) as any;
  if (!job) throw new Error(`job ${key} not found in spec.db`);

  const cust = dbs.spec
    .prepare(`SELECT name, zip, address, phone, email FROM customers WHERE id = ?`)
    .get(Number(job.customer_id)) as any;
  const devs = dbs.spec
    .prepare(
      `SELECT raw_type, model, software, hardware, servos, controller, machine_type, freeform FROM devices WHERE job_key = ? ORDER BY id`,
    )
    .all(key) as any[];
  const notes = dbs.spec
    .prepare(`SELECT kind, body, author, created_at FROM notes WHERE job_key = ? ORDER BY id`)
    .all(key) as any[];

  return {
    key: Number(job.key),
    sorszam: job.sorszam,
    reported_at: job.reported_at,
    reported_at_iso: job.reported_at_iso,
    status: Number(job.status) === 1 ? "closed" : "open",
    technician: job.technician,
    customer: cust
      ? { name: cust.name, zip: cust.zip, address: cust.address, phone: cust.phone, email: cust.email }
      : { name: "(ismeretlen)", zip: null, address: null, phone: null, email: null },
    devices: devs.map((d) => ({
      raw: d.raw_type,
      model: d.model,
      software: d.software,
      hardware: d.hardware,
      servos: d.servos,
      controller: d.controller ?? null,
      machine_type: d.machine_type ?? null,
      freeform: d.freeform,
    })),
    notes: notes.map((n) => ({
      kind: n.kind as Note["kind"],
      body: n.body,
      author: n.author,
      created_at: n.created_at,
    })),
    problem_kategoria: job.problem_kategoria ?? null,
    problem_alkategoria: job.problem_alkategoria ?? null,
    sulyossag: job.sulyossag ?? null,
    _haystack: "",
  };
}

/**
 * Get the next available integer KEY for a new job.
 */
export function nextKey(dbs: OpenDbs): number {
  const r = dbs.cmms.prepare(`SELECT COALESCE(MAX("KEY"), 0) AS m FROM data`).get() as { m: number };
  return Number(r.m) + 1;
}

/**
 * Look up a job key by sorszam (BEJELENTÉS SORSZÁMA).
 * Returns the key or null if not found.
 */
export function keyBySorszam(dbs: OpenDbs, sorszam: string): number | null {
  const row = dbs.spec.prepare(`SELECT key FROM jobs WHERE sorszam = ?`).get(sorszam) as { key: number } | undefined;
  return row ? Number(row.key) : null;
}

/**
 * Strip the internal _haystack field from a JobCard before returning to clients.
 */
export function stripHaystack(c: JobCard): JobCard {
  const { _haystack, ...rest } = c;
  return rest as JobCard;
}

/**
 * Update a single cmms.db column for a job, then rebuild and cache the card.
 * Returns the updated JobCard.
 */
export function setCmmsColumn(
  dbs: OpenDbs,
  key: number,
  column: string,
  value: string | number | null,
): void {
  dbs.cmms.prepare(`UPDATE data SET "${column}" = ? WHERE "KEY" = ?`).run(value, key);
}

/**
 * Look up the customer_id for a job from the spec.db jobs table.
 */
export function getCustomerId(dbs: OpenDbs, key: number): number | null {
  const row = dbs.spec.prepare(`SELECT customer_id FROM jobs WHERE key = ?`).get(key) as { customer_id: number } | undefined;
  return row ? Number(row.customer_id) : null;
}
