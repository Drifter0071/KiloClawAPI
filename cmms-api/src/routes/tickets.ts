// /v1/tickets/*
//
// Interview-style ticket endpoints for the AI clerk.
// Each setter is an atomic update that returns the full updated JobCard.
//
// POST /v1/tickets                       -> open ticket (customer name required)
// POST /v1/tickets/:key/problem          -> set problem description
// POST /v1/tickets/:key/machine          -> set device/equipment
// POST /v1/tickets/:key/location         -> set address + postal code
// POST /v1/tickets/:key/phone            -> set phone number
// POST /v1/tickets/:key/email            -> set email address
// POST /v1/tickets/:key/reporter         -> set reporter + fault receiver
// POST /v1/tickets/:key/technician       -> assign technician
// POST /v1/tickets/:key/solution         -> record completed work
// POST /v1/tickets/:key/payment          -> set payment/warranty status
// POST /v1/tickets/:key/remote-access    -> set remote access info
// POST /v1/tickets/:key/close            -> mark as closed
// POST /v1/tickets/modify                -> modify any field by sorszam
// GET  /v1/tickets/recent                -> recent tickets in a time range
// GET  /v1/tickets/recent-with-solution  -> recent tickets with fixes applied

import type { Router } from "express";
import { Router as makeRouter } from "express";
import type { OpenDbs } from "../db/open";
import type { JobCache, JobCard } from "../cache/jobs";
import { fold, parseDeviceCell } from "../db/parse";
import { classify } from "../lib/classifier";
import { requireAuth } from "./auth";
import {
  makeCardFromSpec,
  nextKey,
  keyBySorszam,
  stripHaystack,
  setCmmsColumn,
  getCustomerId,
} from "./shared";

// --- Shared helpers ---

function ok(card: JobCard, res: any) {
  res.status(201).json(stripHaystack(card));
}

function okGet(card: JobCard, res: any) {
  res.json(stripHaystack(card));
}

function fail(status: number, code: string, message: string, res: any) {
  res.status(status).json({ error: { code, message } });
}

/**
 * Resolve a key (number from URL param) to a validated integer.
 * Returns null and sends 400 if invalid.
 */
function resolveKeyParam(raw: string, res: any): number | null {
  const key = Number(raw);
  if (!Number.isFinite(key)) {
    fail(400, "bad_key", "key must be a number", res);
    return null;
  }
  return key;
}

/**
 * Write devices to cmms.db (KÉSZÜLÉK TIPUSA) + spec.db.
 * Clears existing devices for this job, then inserts the new set.
 */
function writeDevices(dbs: OpenDbs, key: number, devices: string[]): void {
  const deviceCell = devices.filter((d) => d && d.trim() !== "").join(";");
  setCmmsColumn(dbs, key, "KÉSZÜLÉK TIPUSA", deviceCell || null);

  // Clear old device rows and insert new ones
  dbs.spec.prepare(`DELETE FROM devices WHERE job_key = ?`).run(key);
  for (const raw of devices) {
    if (!raw || raw.trim() === "") continue;
    const parsed = parseDeviceCell(raw);
    for (const d of parsed) {
      dbs.stmts.insertDevice.run(
        key,
        d.raw,
        fold(d.raw),
        d.model,
        d.model ? fold(d.model) : null,
        d.software,
        d.hardware,
        d.servos,
        d.controller,
        d.machine_type,
        d.freeform,
      );
    }
  }
}

/**
 * Full transaction: cmms.db update → spec.db update → rebuild card → cache upsert.
 * Returns the updated JobCard.
 */
function applyUpdate(
  dbs: OpenDbs,
  cache: JobCache,
  key: number,
  specFn?: () => void,
): JobCard {
  if (specFn) {
    try {
      specFn();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, error: String((e as Error)?.message ?? e) }));
    }
  }
  try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}
  const card = makeCardFromSpec(dbs, key);
  cache.upsert(card);
  return card;
}

// --- Router ---

export function ticketsRouter(dbs: OpenDbs, cache: JobCache): Router {
  const r = makeRouter();
  const writeGate = requireAuth({ write: true });

  // ---- OPEN TICKET ----
  r.post("/v1/tickets", writeGate, (req, res) => {
    const body = req.body ?? {};
    const customerName = (body.customer_name ?? "").trim();
    if (!customerName) {
      return fail(400, "missing_customer", "customer_name is required", res);
    }

    const sorszam = cache.nextSorszamForThisMonth(dbs.specializedPath);
    const key = nextKey(dbs);
    const nowDate = new Date();
    const reportedAt = nowDate.toISOString().slice(0, 10).replace(/-/g, ".");
    const reportedAtIso = nowDate.toISOString().slice(0, 10);

    // Insert into cmms.db (minimal fields — problem is empty, will be set later)
    const insertCmms = dbs.cmms.prepare(
      `INSERT INTO data (
         "KEY", "BEJELENTÉS SORSZÁMA", "1",
         "AKTUÁLIS NÉV", "IRSZ.", "CÍM", "TELEFON", "E-MAIL",
         "BEJELENTETT HIBA", "ELVÉGZETT MUNKA",
         "NY/Z", "DOLGOZÓ", "KÉSZÜLÉK TIPUSA", "MEGJEGYZÉS",
         "FIZ/GAR", "TÁVOLIGÉPELÉRÉS"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    dbs.cmms.transaction(() => {
      insertCmms.run(
        key,
        sorszam,
        reportedAt,
        customerName,
        body.customer_zip ?? null,
        body.customer_address ?? null,
        body.customer_phone ?? null,
        body.customer_email ?? null,
        null,   // BEJELENTETT HIBA — will be set by set_problem
        null,   // ELVÉGZETT MUNKA — will be set by set_solution
        0,      // NY/Z = open
        null,   // DOLGOZÓ — will be set by set_technician
        null,   // KÉSZÜLÉK TIPUSA — will be set by set_machine
        null,   // MEGJEGYZÉS
        "fiz",
        "nincs",
      );
    })();

    // Mirror into specialized DB
    try {
      dbs.spec.transaction(() => {
        const custRes = dbs.stmts.insertCustomer.run(
          customerName,
          fold(customerName),
          body.customer_zip ?? null,
          body.customer_address ?? null,
          body.customer_address ? fold(body.customer_address) : null,
          body.customer_phone ?? null,
          body.customer_email ?? null,
        );
        const customerId = Number(custRes.lastInsertRowid);
        // Phase 1: insert with the new 16-arg signature. The interview
        // pattern starts with just a customer name; devices and notes
        // are filled in by subsequent /v1/tickets/:key/* setters, after
        // which the inferred columns can be recomputed. For now the
        // inferred fields stay NULL on the open_ticket path — that's
        // fine; the first /v1/tickets/:key/problem call will trigger a
        // reclassify when we wire that up in a later phase.
        dbs.stmts.insertJob.run(
          key,
          sorszam,
          reportedAt,
          reportedAtIso,
          customerId,
          null, // technician
          0,    // status
          null, // problem_kategoria
          null, // problem_alkategoria
          null, // sulyossag
          null, // kategoria_inferred
          null, // kategoria_inferred_conf
          null, // sulyossag_inferred
          null, // sulyossag_inferred_conf
          null, // alkategoria_inferred
          "open", // resolution
        );
        // No devices yet, no notes yet — will be filled by setters
      })();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "open_ticket", error: String((e as Error)?.message ?? e) }));
    }
    try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}

    const card = makeCardFromSpec(dbs, key);
    cache.upsert(card);
    ok(card, res);
  });

  // ---- CREATE TICKET (all fields at once) ----
  r.post("/v1/tickets/create", writeGate, (req, res) => {
    const body = req.body ?? {};
    const customerName = (body.customer_name ?? "").trim();
    if (!customerName) {
      return fail(400, "missing_customer", "customer_name is required", res);
    }

    const sorszam = cache.nextSorszamForThisMonth(dbs.specializedPath);
    const key = nextKey(dbs);
    const nowDate = new Date();
    const reportedAt = nowDate.toISOString().slice(0, 10).replace(/-/g, ".");
    const reportedAtIso = nowDate.toISOString().slice(0, 10);

    const devices: string[] = Array.isArray(body.devices) ? body.devices : [];
    const deviceCell = devices.filter((d) => d && d.trim() !== "").join(";");
    const reported = (body.reported ?? "").trim() || null;
    const work = (body.work ?? "").trim() || null;
    const technician = body.technician ?? null;
    const reporter = body.reporter ?? null;
    const faultReceiver = body.fault_receiver ?? null;
    const payment = ["fiz", "gar"].includes(body.payment) ? body.payment : "fiz";
    const remoteAccess = (body.remote_access ?? "nincs").trim() || "nincs";
    const statusVal = body.status === "closed" ? 1 : 0;
    const kategoria = body.problem_kategoria ?? null;
    const alkategoria = body.problem_alkategoria ?? null;
    const sulyossag = body.sulyossag ?? null;

    const insertCmms = dbs.cmms.prepare(
      `INSERT INTO data (
         "KEY", "BEJELENTÉS SORSZÁMA", "1",
         "AKTUÁLIS NÉV", "IRSZ.", "CÍM", "TELEFON", "E-MAIL",
         "BEJELENTETT HIBA", "ELVÉGZETT MUNKA",
         "NY/Z", "DOLGOZÓ", "KÉSZÜLÉK TIPUSA", "MEGJEGYZÉS",
         "FIZ/GAR", "TÁVOLIGÉPELÉRÉS"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      dbs.cmms.transaction(() => {
        insertCmms.run(
          key,
          sorszam,
          reportedAt,
          customerName,
          body.customer_zip ?? null,
          body.customer_address ?? null,
          body.customer_phone ?? null,
          body.customer_email ?? null,
          reported,
          work,
          statusVal,
          technician,
          deviceCell || null,
          null,
          payment,
          remoteAccess,
        );
      })();
    } catch (e) {
      return fail(500, "cmms_write_failed", String((e as Error)?.message ?? e), res);
    }

    try {
      dbs.spec.transaction(() => {
        const custRes = dbs.stmts.insertCustomer.run(
          customerName,
          fold(customerName),
          body.customer_zip ?? null,
          body.customer_address ?? null,
          body.customer_address ? fold(body.customer_address) : null,
          body.customer_phone ?? null,
          body.customer_email ?? null,
        );
        const customerId = Number(custRes.lastInsertRowid);
        // Phase 1: also persist the inferred kategoria / sulyossag /
        // alkategoria for the new ticket so it's queryable from the
        // moment it's created.
        const allDevices: ReturnType<typeof parseDeviceCell> = [];
        for (const raw of devices) {
          if (!raw || raw.trim() === "") continue;
          for (const d of parseDeviceCell(raw)) allDevices.push(d);
        }
        const inferred = classify({
          reported: reported ?? null,
          work: work ?? null,
          devices: allDevices.map((d) => ({
            model: d.model,
            controller: d.controller,
            machine_type: d.machine_type,
            raw: d.raw,
          })),
        });
        dbs.stmts.insertJob.run(
          key,
          sorszam,
          reportedAt,
          reportedAtIso,
          customerId,
          technician,
          statusVal,
          kategoria,
          alkategoria,
          sulyossag,
          inferred.kategoria_inferred,
          inferred.kategoria_confidence,
          inferred.sulyossag_inferred,
          inferred.sulyossag_confidence,
          inferred.alkategoria_inferred,
          statusVal === 1 ? "closed" : "open", // resolution
        );

        // Link to category in junction table.
        if (kategoria) {
          const katRow = dbs.stmts.getProblemaKategoriaByName.get(kategoria) as { id: number } | undefined;
          if (katRow) {
            dbs.stmts.linkTicketProblema.run(key, katRow.id);
          }
        }

        for (const d of allDevices) {
          dbs.stmts.insertDevice.run(
            key,
            d.raw,
            fold(d.raw),
            d.model,
            d.model ? fold(d.model) : null,
            d.software,
            d.hardware,
            d.servos,
            d.controller,
            d.machine_type,
            d.freeform,
          );
        }

        if (reported) {
          dbs.stmts.insertNote.run(key, "reported", reported, fold(reported), null, reportedAtIso);
        }
        if (work) {
          dbs.stmts.insertNote.run(key, "work", work, fold(work), null, reportedAtIso);
        }
      })();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "create_ticket", error: String((e as Error)?.message ?? e) }));
    }
    try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}

    const card = makeCardFromSpec(dbs, key);
    cache.upsert(card);
    ok(card, res);
  });

  // ---- SET PROBLEM ----
  r.post("/v1/tickets/:key/problem", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const text = (req.body?.text ?? "").trim();
    if (!text) return fail(400, "missing_text", "text is required", res);

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    const nowIso = new Date().toISOString();
    const stamp = nowIso.slice(0, 10);
    const line = `-- ${stamp}: ${text}`;

    dbs.cmms.transaction(() => {
      const cur = dbs.cmms
        .prepare(`SELECT "BEJELENTETT HIBA" AS r FROM data WHERE "KEY" = ?`)
        .get(key) as { r: string | null } | undefined;
      if (!cur) throw new Error("__NOT_FOUND__");
      const next = cur.r && String(cur.r).trim() !== "" ? `${cur.r}\n${line}` : line;
      dbs.cmms.prepare(`UPDATE data SET "BEJELENTETT HIBA" = ? WHERE "KEY" = ?`).run(next, key);
    })();

    try {
      dbs.spec.transaction(() => {
        dbs.stmts.insertNote.run(key, "reported", text, fold(text), null, nowIso);
      })();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "set_problem", error: String((e as Error)?.message ?? e) }));
    }
    try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- SET MACHINE ----
  r.post("/v1/tickets/:key/machine", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const devices: string[] = req.body?.devices;
    if (!Array.isArray(devices) || devices.length === 0) {
      return fail(400, "missing_devices", "devices array is required", res);
    }

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    dbs.cmms.transaction(() => {
      const deviceCell = devices.filter((d) => d && d.trim() !== "").join(";");
      setCmmsColumn(dbs, key, "KÉSZÜLÉK TIPUSA", deviceCell || null);
    })();

    try {
      dbs.spec.prepare(`DELETE FROM devices WHERE job_key = ?`).run(key);
      for (const raw of devices) {
        if (!raw || raw.trim() === "") continue;
        const parsed = parseDeviceCell(raw);
        for (const d of parsed) {
          dbs.stmts.insertDevice.run(
            key,
            d.raw,
            fold(d.raw),
            d.model,
            d.model ? fold(d.model) : null,
            d.software,
            d.hardware,
            d.servos,
            d.controller,
            d.machine_type,
            d.freeform,
          );
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "set_machine", error: String((e as Error)?.message ?? e) }));
    }
    try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- SET LOCATION ----
  r.post("/v1/tickets/:key/location", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const address = (req.body?.address ?? "").trim();
    if (!address) return fail(400, "missing_address", "address is required", res);

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    const zip = req.body?.zip ?? null;

    dbs.cmms.transaction(() => {
      setCmmsColumn(dbs, key, "CÍM", address);
      if (zip !== null) setCmmsColumn(dbs, key, "IRSZ.", zip);
    })();

    const customerId = getCustomerId(dbs, key);
    if (customerId !== null) {
      try {
        dbs.spec.prepare(`UPDATE customers SET address = ?, address_ascii = ?, zip = COALESCE(?, zip) WHERE id = ?`)
          .run(address, fold(address), zip, customerId);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "set_location", error: String((e as Error)?.message ?? e) }));
      }
    }
    try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- SET PHONE ----
  r.post("/v1/tickets/:key/phone", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const phone = (req.body?.phone ?? "").trim();
    if (!phone) return fail(400, "missing_phone", "phone is required", res);

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    setCmmsColumn(dbs, key, "TELEFON", phone);
    const customerId = getCustomerId(dbs, key);
    if (customerId !== null) {
      try {
        dbs.spec.prepare(`UPDATE customers SET phone = ? WHERE id = ?`).run(phone, customerId);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "set_phone", error: String((e as Error)?.message ?? e) }));
      }
    }

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- SET EMAIL ----
  r.post("/v1/tickets/:key/email", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const email = (req.body?.email ?? "").trim();
    if (!email) return fail(400, "missing_email", "email is required", res);

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    setCmmsColumn(dbs, key, "E-MAIL", email);
    const customerId = getCustomerId(dbs, key);
    if (customerId !== null) {
      try {
        dbs.spec.prepare(`UPDATE customers SET email = ? WHERE id = ?`).run(email, customerId);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "set_email", error: String((e as Error)?.message ?? e) }));
      }
    }

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- SET REPORTER ----
  r.post("/v1/tickets/:key/reporter", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const reporter = (req.body?.reporter ?? "").trim();
    if (!reporter) return fail(400, "missing_reporter", "reporter is required", res);

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    setCmmsColumn(dbs, key, "BEJELENTŐ", reporter);
    const faultReceiver = req.body?.fault_receiver ?? null;
    if (faultReceiver) {
      setCmmsColumn(dbs, key, "HIBAFELVEVŐ", faultReceiver);
    }

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- SET TECHNICIAN ----
  r.post("/v1/tickets/:key/technician", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const technician = (req.body?.technician ?? "").trim();
    if (!technician) return fail(400, "missing_technician", "technician is required", res);

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    setCmmsColumn(dbs, key, "DOLGOZÓ", technician);
    try {
      dbs.spec.prepare(`UPDATE jobs SET technician = ? WHERE key = ?`).run(technician, key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "set_technician", error: String((e as Error)?.message ?? e) }));
    }

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- SET SOLUTION ----
  r.post("/v1/tickets/:key/solution", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const text = (req.body?.text ?? "").trim();
    if (!text) return fail(400, "missing_text", "text is required", res);

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    const nowIso = new Date().toISOString();
    const stamp = nowIso.slice(0, 10);
    const author = req.body?.author ?? null;
    const line = `-- ${stamp}${author ? " " + author : ""}: ${text}`;

    dbs.cmms.transaction(() => {
      const cur = dbs.cmms
        .prepare(`SELECT "ELVÉGZETT MUNKA" AS w FROM data WHERE "KEY" = ?`)
        .get(key) as { w: string | null } | undefined;
      if (!cur) throw new Error("__NOT_FOUND__");
      const next = cur.w && String(cur.w).trim() !== "" ? `${cur.w}\n${line}` : line;
      dbs.cmms.prepare(`UPDATE data SET "ELVÉGZETT MUNKA" = ? WHERE "KEY" = ?`).run(next, key);
    })();

    try {
      dbs.spec.transaction(() => {
        dbs.stmts.insertNote.run(key, "work", text, fold(text), author, nowIso);
      })();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "set_solution", error: String((e as Error)?.message ?? e) }));
    }
    try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- SET PAYMENT ----
  r.post("/v1/tickets/:key/payment", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const payment = (req.body?.payment ?? "").trim();
    if (!payment || !["fiz", "gar"].includes(payment)) {
      return fail(400, "bad_payment", "payment must be 'fiz' or 'gar'", res);
    }

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    setCmmsColumn(dbs, key, "FIZ/GAR", payment);

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- SET REMOTE ACCESS ----
  r.post("/v1/tickets/:key/remote-access", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const remoteAccess = (req.body?.remote_access ?? "").trim();
    if (!remoteAccess) return fail(400, "missing_remote_access", "remote_access is required", res);

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    setCmmsColumn(dbs, key, "TÁVOLIGÉPELÉRÉS", remoteAccess);

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- REMOVE TICKET ----
  r.delete("/v1/tickets/:key", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    // 1. Delete from cmms.db
    try {
      dbs.cmms.prepare(`DELETE FROM data WHERE "KEY" = ?`).run(key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "cmms_delete_error", key, error: String((e as Error)?.message ?? e) }));
      return fail(500, "cmms_delete_failed", String((e as Error)?.message ?? e), res);
    }

    // 2. Delete from spec.db (cascade via FK or manual)
    try {
      dbs.spec.prepare(`DELETE FROM notes WHERE job_key = ?`).run(key);
      dbs.spec.prepare(`DELETE FROM devices WHERE job_key = ?`).run(key);
      dbs.spec.prepare(`DELETE FROM jobs WHERE key = ?`).run(key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_delete_error", key, error: String((e as Error)?.message ?? e) }));
    }

    // 3. Remove from cache
    cache.delete(key);

    res.status(200).json({ deleted: true, key });
  });

  // ---- CLOSE TICKET ----
  r.post("/v1/tickets/:key/close", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);

    const solutionText = (req.body?.text ?? "").trim();

    if (solutionText) {
      const nowIso = new Date().toISOString();
      const stamp = nowIso.slice(0, 10);
      const author = req.body?.author ?? null;
      const line = `-- ${stamp}${author ? " " + author : ""}: ${solutionText}`;

      dbs.cmms.transaction(() => {
        const cur = dbs.cmms
          .prepare(`SELECT "ELVÉGZETT MUNKA" AS w FROM data WHERE "KEY" = ?`)
          .get(key) as { w: string | null } | undefined;
        const prev = cur?.w && String(cur.w).trim() !== "" ? cur.w : null;
        const next = prev ? `${prev}\n${line}` : line;
        dbs.cmms.prepare(`UPDATE data SET "ELVÉGZETT MUNKA" = ?, "NY/Z" = 1 WHERE "KEY" = ?`).run(next, key);
      })();

      try {
        dbs.spec.transaction(() => {
          dbs.stmts.insertNote.run(key, "work", solutionText, fold(solutionText), author, nowIso);
        })();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "close_ticket_solution", error: String((e as Error)?.message ?? e) }));
      }
    } else {
      dbs.cmms.transaction(() => {
        setCmmsColumn(dbs, key, "NY/Z", 1);
      })();
    }

    try {
      dbs.spec.prepare(`UPDATE jobs SET status = 1 WHERE key = ?`).run(key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "close_ticket", error: String((e as Error)?.message ?? e) }));
    }

    const card = applyUpdate(dbs, cache, key);
    ok(card, res);
  });

  // ---- MODIFY BY SORSZAM ----
  r.post("/v1/tickets/modify", writeGate, (req, res) => {
    const body = req.body ?? {};
    const sorszam = (body.sorszam ?? "").trim();
    if (!sorszam) return fail(400, "missing_sorszam", "sorszam is required", res);

    const key = keyBySorszam(dbs, sorszam);
    if (key === null) return fail(404, "not_found", `job with sorszam '${sorszam}' not found`, res);

    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not in cache`, res);

    // Apply each provided field (whitelist)
    const customerId = getCustomerId(dbs, key);

    try {
      dbs.cmms.transaction(() => {
        if (body.customer_name !== undefined) {
          const name = String(body.customer_name).trim();
          setCmmsColumn(dbs, key, "AKTUÁLIS NÉV", name);
          if (customerId !== null) {
            dbs.spec.prepare(`UPDATE customers SET name = ?, name_ascii = ? WHERE id = ?`)
              .run(name, fold(name), customerId);
          }
        }
        if (body.customer_zip !== undefined) {
          setCmmsColumn(dbs, key, "IRSZ.", body.customer_zip || null);
          if (customerId !== null) {
            dbs.spec.prepare(`UPDATE customers SET zip = ? WHERE id = ?`)
              .run(body.customer_zip || null, customerId);
          }
        }
        if (body.customer_address !== undefined) {
          const addr = String(body.customer_address).trim();
          setCmmsColumn(dbs, key, "CÍM", addr || null);
          if (customerId !== null) {
            dbs.spec.prepare(`UPDATE customers SET address = ?, address_ascii = ? WHERE id = ?`)
              .run(addr || null, fold(addr), customerId);
          }
        }
        if (body.customer_phone !== undefined) {
          setCmmsColumn(dbs, key, "TELEFON", body.customer_phone || null);
          if (customerId !== null) {
            dbs.spec.prepare(`UPDATE customers SET phone = ? WHERE id = ?`)
              .run(body.customer_phone || null, customerId);
          }
        }
        if (body.customer_email !== undefined) {
          setCmmsColumn(dbs, key, "E-MAIL", body.customer_email || null);
          if (customerId !== null) {
            dbs.spec.prepare(`UPDATE customers SET email = ? WHERE id = ?`)
              .run(body.customer_email || null, customerId);
          }
        }
        if (body.technician !== undefined) {
          const tech = String(body.technician).trim();
          setCmmsColumn(dbs, key, "DOLGOZÓ", tech || null);
          dbs.spec.prepare(`UPDATE jobs SET technician = ? WHERE key = ?`).run(tech || null, key);
        }
        if (body.reporter !== undefined) {
          setCmmsColumn(dbs, key, "BEJELENTŐ", String(body.reporter).trim() || null);
        }
        if (body.fault_receiver !== undefined) {
          setCmmsColumn(dbs, key, "HIBAFELVEVŐ", String(body.fault_receiver).trim() || null);
        }
        if (body.payment !== undefined) {
          const p = String(body.payment).trim();
          if (["fiz", "gar"].includes(p)) setCmmsColumn(dbs, key, "FIZ/GAR", p);
        }
        if (body.remote_access !== undefined) {
          setCmmsColumn(dbs, key, "TÁVOLIGÉPELÉRÉS", String(body.remote_access).trim() || null);
        }
        if (body.status !== undefined) {
          const s = body.status === "closed" ? 1 : 0;
          setCmmsColumn(dbs, key, "NY/Z", s);
          dbs.spec.prepare(`UPDATE jobs SET status = ? WHERE key = ?`).run(s, key);
        }
        if (body.problem_kategoria !== undefined) {
          const kat = String(body.problem_kategoria).trim() || null;
          dbs.spec.prepare(`UPDATE jobs SET problem_kategoria = ? WHERE key = ?`).run(kat, key);
          // Update junction table.
          dbs.spec.prepare(`DELETE FROM ticket_problema WHERE ticket_key = ?`).run(key);
          if (kat) {
            const katRow = dbs.stmts.getProblemaKategoriaByName.get(kat) as { id: number } | undefined;
            if (katRow) {
              dbs.stmts.linkTicketProblema.run(key, katRow.id);
            }
          }
        }
        if (body.problem_alkategoria !== undefined) {
          const alk = String(body.problem_alkategoria).trim() || null;
          dbs.spec.prepare(`UPDATE jobs SET problem_alkategoria = ? WHERE key = ?`).run(alk, key);
        }
        if (body.sulyossag !== undefined) {
          const sul = String(body.sulyossag).trim() || null;
          dbs.spec.prepare(`UPDATE jobs SET sulyossag = ? WHERE key = ?`).run(sul, key);
        }
      })();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: "modify_write_error", key, error: String((e as Error)?.message ?? e) }));
    }

    // Handle devices separately (needs parseDeviceCell + delete/insert)
    if (body.device !== undefined) {
      const devices = Array.isArray(body.device)
        ? body.device
        : String(body.device).split(";").map((s) => s.trim()).filter(Boolean);
      try {
        dbs.spec.transaction(() => {
          writeDevices(dbs, key, devices);
        })();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "modify_devices", error: String((e as Error)?.message ?? e) }));
      }
    }

    // Handle reported/work text (needs note append)
    if (body.reported !== undefined) {
      const text = String(body.reported).trim();
      const nowIso = new Date().toISOString();
      const stamp = nowIso.slice(0, 10);
      const line = `-- ${stamp}: ${text}`;
      dbs.cmms.transaction(() => {
        const cur = dbs.cmms
          .prepare(`SELECT "BEJELENTETT HIBA" AS r FROM data WHERE "KEY" = ?`)
          .get(key) as { r: string | null } | undefined;
        const next = cur?.r && String(cur.r).trim() !== "" ? `${cur.r}\n${line}` : line;
        dbs.cmms.prepare(`UPDATE data SET "BEJELENTETT HIBA" = ? WHERE "KEY" = ?`).run(next, key);
      })();
      try {
        dbs.spec.transaction(() => {
          dbs.stmts.insertNote.run(key, "reported", text, fold(text), null, nowIso);
        })();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "modify_reported", error: String((e as Error)?.message ?? e) }));
      }
    }
    if (body.work !== undefined) {
      const text = String(body.work).trim();
      const nowIso = new Date().toISOString();
      const stamp = nowIso.slice(0, 10);
      const line = `-- ${stamp}: ${text}`;
      dbs.cmms.transaction(() => {
        const cur = dbs.cmms
          .prepare(`SELECT "ELVÉGZETT MUNKA" AS w FROM data WHERE "KEY" = ?`)
          .get(key) as { w: string | null } | undefined;
        const next = cur?.w && String(cur.w).trim() !== "" ? `${cur.w}\n${line}` : line;
        dbs.cmms.prepare(`UPDATE data SET "ELVÉGZETT MUNKA" = ? WHERE "KEY" = ?`).run(next, key);
      })();
      try {
        dbs.spec.transaction(() => {
          dbs.stmts.insertNote.run(key, "work", text, fold(text), null, nowIso);
        })();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: "spec_write_error", key, op: "modify_work", error: String((e as Error)?.message ?? e) }));
      }
    }

    try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}
    const card = applyUpdate(dbs, cache, key);
    okGet(card, res);
  });

  // ---- GET RECENT TICKETS ----
  r.get("/v1/tickets/recent", (req, res) => {
    const hours = Math.max(1, Math.min(720, Number(req.query.hours) || 24));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const statusFilter = req.query.status as string | undefined;

    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 10);
    const hits: JobCard[] = [];

    for (const card of cache.allJobs()) {
      if (!card.reported_at_iso || card.reported_at_iso < cutoff) continue;
      if (statusFilter === "open" && card.status !== "open") continue;
      if (statusFilter === "closed" && card.status !== "closed") continue;
      hits.push(card);
      if (hits.length >= limit) break;
    }

    res.json({
      total: hits.length,
      jobs: hits.map(stripHaystack),
    });
  });

  // ---- GET RECENT WITH SOLUTION ----
  r.get("/v1/tickets/recent-with-solution", (req, res) => {
    const hours = Math.max(1, Math.min(720, Number(req.query.hours) || 168));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));

    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const hits: JobCard[] = [];

    for (const card of cache.allJobs()) {
      const hasWork = card.notes.some(
        (n) => n.kind === "work" && n.created_at && n.created_at >= cutoff,
      );
      if (!hasWork) continue;
      hits.push(card);
      if (hits.length >= limit) break;
    }

    res.json({
      total: hits.length,
      jobs: hits.map(stripHaystack),
    });
  });

  // ---- GET ALL CATEGORIES ----
  r.get("/v1/categories", (req, res) => {
    const cats = dbs.stmts.getAllProblemaKategoriak.all();
    res.json({ total: cats.length, categories: cats });
  });

  // ---- CREATE CATEGORY ----
  r.post("/v1/categories", writeGate, (req, res) => {
    const body = req.body ?? {};
    const nev = (body.nev ?? "").trim();
    if (!nev) return fail(400, "missing_nev", "nev (category name) is required", res);
    const leiras = body.leiras ?? null;
    const nevAscii = fold(nev);
    try {
      const result = dbs.stmts.insertProblemaKategoria.run(nev, nevAscii, leiras);
      res.status(201).json({ id: result.lastInsertRowid, nev, nev_ascii: nevAscii, leiras });
    } catch {
      fail(409, "duplicate", `category '${nev}' already exists`, res);
    }
  });

  // ---- GET ALL TAGS ----
  r.get("/v1/tags", (req, res) => {
    const tags = dbs.stmts.getAllProblemaCimkek.all();
    res.json({ total: tags.length, tags });
  });

  // ---- CREATE TAG ----
  r.post("/v1/tags", writeGate, (req, res) => {
    const body = req.body ?? {};
    const nev = (body.nev ?? "").trim();
    if (!nev) return fail(400, "missing_nev", "nev (tag name) is required", res);
    try {
      const result = dbs.stmts.insertProblemaCimke.run(nev);
      res.status(201).json({ id: result.lastInsertRowid, nev });
    } catch {
      fail(409, "duplicate", `tag '${nev}' already exists`, res);
    }
  });

  // ---- GET TICKET CATEGORIES ----
  r.get("/v1/tickets/:key/categories", (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const cats = dbs.stmts.getTicketProblemaKategoriak.all(key);
    res.json({ ticket_key: key, categories: cats });
  });

  // ---- ADD TICKET CATEGORY ----
  r.post("/v1/tickets/:key/categories", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);
    const body = req.body ?? {};
    const kategoriaId = Number(body.kategoria_id);
    if (!Number.isFinite(kategoriaId)) return fail(400, "bad_kategoria_id", "kategoria_id must be a number", res);
    const katRow = dbs.stmts.getProblemaKategoriaById.get(kategoriaId) as { id: number; nev: string } | undefined;
    if (!katRow) return fail(404, "category_not_found", `category ${kategoriaId} not found`, res);
    dbs.stmts.linkTicketProblema.run(key, kategoriaId);
    if (!existing.problem_kategoria) {
      dbs.spec.prepare(`UPDATE jobs SET problem_kategoria = ? WHERE key = ?`).run(katRow.nev, key);
      const card = applyUpdate(dbs, cache, key);
      okGet(card, res);
    } else {
      const cats = dbs.stmts.getTicketProblemaKategoriak.all(key);
      res.json({ ticket_key: key, categories: cats });
    }
  });

  // ---- REMOVE TICKET CATEGORY ----
  r.delete("/v1/tickets/:key/categories/:katId", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const katId = Number(req.params.katId);
    if (!Number.isFinite(katId)) return fail(400, "bad_katId", "katId must be a number", res);
    dbs.stmts.unlinkTicketProblema.run(key, katId);
    const cats = dbs.stmts.getTicketProblemaKategoriak.all(key);
    res.json({ ticket_key: key, categories: cats });
  });

  // ---- GET TICKET TAGS ----
  r.get("/v1/tickets/:key/tags", (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const tags = dbs.stmts.getTicketCimkek.all(key);
    res.json({ ticket_key: key, tags });
  });

  // ---- ADD TICKET TAG ----
  r.post("/v1/tickets/:key/tags", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const existing = cache.get(key);
    if (!existing) return fail(404, "not_found", `job ${key} not found`, res);
    const body = req.body ?? {};
    const cimkeNev = (body.nev ?? "").trim();
    if (!cimkeNev) return fail(400, "missing_nev", "nev (tag name) is required", res);
    let tagRow = dbs.stmts.getProblemaCimkeByName.get(cimkeNev) as { id: number } | undefined;
    if (!tagRow) {
      const result = dbs.stmts.insertProblemaCimke.run(cimkeNev);
      tagRow = { id: Number(result.lastInsertRowid) };
    }
    dbs.stmts.linkTicketCimke.run(key, tagRow.id);
    const tags = dbs.stmts.getTicketCimkek.all(key);
    res.json({ ticket_key: key, tags });
  });

  // ---- REMOVE TICKET TAG ----
  r.delete("/v1/tickets/:key/tags/:tagId", writeGate, (req, res) => {
    const key = resolveKeyParam(req.params.key, res);
    if (key === null) return;
    const tagId = Number(req.params.tagId);
    if (!Number.isFinite(tagId)) return fail(400, "bad_tagId", "tagId must be a number", res);
    dbs.stmts.unlinkTicketCimke.run(key, tagId);
    const tags = dbs.stmts.getTicketCimkek.all(key);
    res.json({ ticket_key: key, tags });
  });

  return r;
}
