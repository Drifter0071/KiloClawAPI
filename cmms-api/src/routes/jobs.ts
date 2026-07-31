// /v1/jobs/*
//   POST /v1/jobs/search   -> search JobCards
//   GET  /v1/jobs/:key     -> single JobCard
//   GET  /v1/jobs/:key/raw -> untouched original row from cmms.db
//   POST /v1/jobs          -> create new job (write token required)
//   POST /v1/jobs/:key/notes -> append note (write token required)
import type { Router } from "express";
import { Router as makeRouter } from "express";
import type { OpenDbs } from "../db/open";
import type { JobCache, JobCard } from "../cache/jobs";
import { fold, parseDeviceCell } from "../db/parse";
import { resolvePeriod } from "../lib/period";
import { requireAuth } from "./auth";
import { makeCardFromSpec, nextKey, stripHaystack } from "./shared";

type CreateBody = {
  customer?: { name?: string; zip?: string; address?: string; phone?: string; email?: string };
  devices?: string[];
  reported?: string;
  work?: string;
  technician?: string;
};

type AppendBody = { kind?: "reported" | "work" | "free"; body?: string; author?: string };

export function jobsRouter(dbs: OpenDbs, cache: JobCache): Router {
  const r = makeRouter();

  // Read endpoints.
  r.post("/v1/jobs/search", (req, res) => {
    const body = (req.body ?? {}) as {
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
      period?: string;
      limit?: number;
      offset?: number;
      fields?: string[];
    };
    // Server-side period resolution: if a `period` token is supplied,
    // resolve it to concrete (date_from, date_to). Explicit date_from /
    // date_to win, then period is consulted as a fallback. This makes
    // "this month" / "last 30 days" queries deterministic regardless
    // of the model's date arithmetic.
    const period = resolvePeriod(body.period, new Date(), {
      date_from: body.date_from ?? null,
      date_to: body.date_to ?? null,
    });
    const result = cache.search({
      ...body,
      date_from: period.date_from ?? undefined,
      date_to: period.date_to ?? undefined,
    });
    const limit = Math.max(1, Math.min(100, body.limit ?? 20));
    const offset = Math.max(0, body.offset ?? 0);
    res.json({
      total: result.total,
      offset,
      limit,
      period: {
        token: body.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
      jobs: result.hits.map((h) =>
        body.fields && body.fields.length > 0
          ? h.job
          : stripHaystack(h.job),
      ),
    });
  });

  // Stats/aggregation endpoint.
  r.post("/v1/jobs/stats", (req, res) => {
    const body = (req.body ?? {}) as {
      group_by?: "customer" | "device" | "technician" | "status" | "month" | "kategoria" | "sulyossag" | "machine_type" | "controller" | "kategoria_inferred" | "sulyossag_inferred" | "alkategoria_inferred" | "resolution";
      q?: string;
      customer?: string;
      device?: string;
      status?: "open" | "closed";
      date_from?: string;
      date_to?: string;
      kategoria?: string;
      sulyossag?: string;
      controller?: string;
      period?: string;
      include_evidence?: boolean;
      evidence_per_group?: number;
      limit?: number;
    };
    const groupBy = body.group_by ?? "customer";
    const validGroupBy = ["customer", "device", "technician", "status", "month", "kategoria", "sulyossag", "machine_type", "controller", "kategoria_inferred", "sulyossag_inferred", "alkategoria_inferred", "resolution"];
    if (!validGroupBy.includes(groupBy)) {
      res.status(400).json({ error: { code: "bad_group_by", message: `group_by must be one of: ${validGroupBy.join(", ")}` } });
      return;
    }
    const period = resolvePeriod(body.period, new Date(), {
      date_from: body.date_from ?? null,
      date_to: body.date_to ?? null,
    });
    const includeEvidence = body.include_evidence !== false; // default ON
    const evidencePerGroup = Math.max(0, Math.min(5, body.evidence_per_group ?? 2));
    const results = cache.stats({
      ...body,
      date_from: period.date_from ?? undefined,
      date_to: period.date_to ?? undefined,
      group_by: groupBy,
    });
    // Evidence: for each top-N result, return up to evidencePerGroup
    // sample sorszam + snippet, so the LLM (and the human) can cite
    // a real ticket instead of trusting the count blindly.
    const evidence = includeEvidence
      ? Object.fromEntries(
          results.slice(0, 10).map((r) => [
            r.name,
            cache.sampleTickets({
              ...body,
              date_from: period.date_from ?? undefined,
              date_to: period.date_to ?? undefined,
              group_by: r.name,
              group_by_field: groupBy,
              limit: evidencePerGroup,
            }),
          ]),
        )
      : undefined;
    res.json({
      group_by: groupBy,
      total: results.length,
      period: {
        token: body.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
      results,
      ...(evidence ? { evidence } : {}),
    });
  });

  // Recurring-problem search. Groups tickets by root-cause signature and
  // returns clusters of 2+ tickets that share the same machine, controller,
  // problem category, etc. See src/lib/cluster.ts.
  r.post("/v1/jobs/recurring-problems", (req, res) => {
    const body = (req.body ?? {}) as {
      customer?: string;
      machine?: string;
      controller?: string;
      software?: string;
      hardware?: string;
      kategoria?: string;
      alkategoria?: string;
      date_from?: string;
      date_to?: string;
      period?: string;
      scope?: "narrow" | "broad" | "broadest";
      min_visits?: number;
      limit?: number;
    };
    const period = resolvePeriod(body.period, new Date(), {
      date_from: body.date_from ?? null,
      date_to: body.date_to ?? null,
    });
    const result = cache.recurringProblems({
      customer: body.customer,
      machine: body.machine,
      controller: body.controller,
      software: body.software,
      hardware: body.hardware,
      kategoria: body.kategoria,
      alkategoria: body.alkategoria,
      date_from: period.date_from ?? body.date_from,
      date_to: period.date_to ?? body.date_to,
      scope: body.scope ?? "broad",
      min_visits: body.min_visits,
      limit: body.limit,
    });
    res.json({
      ...result,
      period: {
        token: body.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    });
  });

  r.post("/v1/jobs/recurring-problems/cluster", (req, res) => {
    const body = (req.body ?? {}) as {
      customer?: string;
      machine?: string;
      controller?: string;
      software?: string;
      hardware?: string;
      kategoria?: string;
      alkategoria?: string;
      date_from?: string;
      date_to?: string;
      period?: string;
      scope?: "narrow" | "broad" | "broadest";
      limit?: number;
    };
    const period = resolvePeriod(body.period, new Date(), {
      date_from: body.date_from ?? null,
      date_to: body.date_to ?? null,
    });
    const result = cache.problemCluster({
      customer: body.customer,
      machine: body.machine,
      controller: body.controller,
      software: body.software,
      hardware: body.hardware,
      kategoria: body.kategoria,
      alkategoria: body.alkategoria,
      date_from: period.date_from ?? body.date_from,
      date_to: period.date_to ?? body.date_to,
      scope: body.scope ?? "broad",
      limit: body.limit,
    });
    if (!result) {
      res.status(404).json({ error: { code: "not_found", message: "no cluster matches the given signature" } });
      return;
    }
    res.json({
      signature: result.signature,
      cluster: result.cluster,
      tickets: result.tickets.map(stripHaystack),
      period: {
        token: body.period ?? null,
        resolved_token: period.resolved_token,
        date_from: period.date_from,
        date_to: period.date_to,
        label_en: period.label_en,
        label_hu: period.label_hu,
      },
    });
  });

  r.get("/v1/jobs/:key", (req, res) => {
    const key = Number(req.params.key);
    if (!Number.isFinite(key)) {
      res.status(400).json({ error: { code: "bad_key", message: "key must be a number" } });
      return;
    }
    const card = cache.get(key);
    if (!card) {
      res.status(404).json({ error: { code: "not_found", message: `job ${key} not found` } });
      return;
    }
    res.json(stripHaystack(card));
  });

  r.get("/v1/jobs/:key/raw", (req, res) => {
    const key = Number(req.params.key);
    if (!Number.isFinite(key)) {
      res.status(400).json({ error: { code: "bad_key", message: "key must be a number" } });
      return;
    }
    const stmt = dbs.cmms.prepare(`SELECT * FROM data WHERE "KEY" = ? LIMIT 1`);
    const row = stmt.get(key) as Record<string, any> | undefined;
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: `row ${key} not found in cmms.db` } });
      return;
    }
    res.json(row);
  });

  // Write endpoints, gated by the write token. We construct a fresh gate
  // per request so it always sees the current env.
  const writeGate = requireAuth({ write: true });

  r.post("/v1/jobs", writeGate, (req, res) => {
    const body = (req.body ?? {}) as CreateBody;
    const customerName = (body.customer?.name ?? "").trim();
    const reported = (body.reported ?? "").trim();
    if (!customerName) {
      res.status(400).json({ error: { code: "missing_customer", message: "customer.name is required" } });
      return;
    }
    if (!reported) {
      res.status(400).json({ error: { code: "missing_reported", message: "reported (Bejelentett hiba) is required" } });
      return;
    }

    const created = createNewJob(dbs, cache, body);
    if (!created.ok) {
      res.status(created.status).json({ error: { code: created.code, message: created.message } });
      return;
    }
    res.status(201).json(stripHaystack(created.card));
  });

  r.post("/v1/jobs/:key/notes", writeGate, (req, res) => {
    const key = Number(req.params.key);
    if (!Number.isFinite(key)) {
      res.status(400).json({ error: { code: "bad_key", message: "key must be a number" } });
      return;
    }
    const body = (req.body ?? {}) as AppendBody;
    if (!body.kind || !["reported", "work", "free"].includes(body.kind)) {
      res.status(400).json({ error: { code: "bad_kind", message: "kind must be 'reported', 'work', or 'free'" } });
      return;
    }
    if (!body.body || body.body.trim() === "") {
      res.status(400).json({ error: { code: "missing_body", message: "body is required" } });
      return;
    }
    const existing = cache.get(key);
    if (!existing) {
      res.status(404).json({ error: { code: "not_found", message: `job ${key} not found` } });
      return;
    }
    const nowIso = new Date().toISOString();
    const appended = appendNote(dbs, cache, key, body, nowIso);
    if (!appended.ok) {
      res.status(appended.status).json({ error: { code: appended.code, message: appended.message } });
      return;
    }
    res.status(201).json(stripHaystack(appended.card));
  });

  return r;
}

function createNewJob(
  dbs: OpenDbs,
  cache: JobCache,
  body: CreateBody,
): { ok: true; card: JobCard } | { ok: false; status: number; code: string; message: string } {
  const sorszam = cache.nextSorszamForThisMonth(dbs.specializedPath);
  const key = nextKey(dbs);
  const nowDate = new Date();
  const reportedAt = nowDate.toISOString().slice(0, 10).replace(/-/g, ".");
  const reportedAtIso = nowDate.toISOString().slice(0, 10);
  const customer = body.customer ?? {};
  const customerName = customer.name!.trim();
  const devices = body.devices ?? [];
  const reported = body.reported!.trim();
  const work = (body.work ?? "").trim();
  const technician = body.technician ?? null;

  // Compose KÉSZÜLÉK TIPUSA cell.
  const deviceCell = devices.filter((d) => d && d.trim() !== "").join(";");

  // Insert into cmms.db first.
  const insertCmms = dbs.cmms.prepare(
    `INSERT INTO data (
       "KEY", "BEJELENTÉS SORSZÁMA", "1",
       "AKTUÁLIS NÉV", "IRSZ.", "CÍM", "TELEFON", "E-MAIL",
       "BEJELENTETT HIBA", "ELVÉGZETT MUNKA",
       "NY/Z", "DOLGOZÓ", "KÉSZÜLÉK TIPUSA", "MEGJEGYZÉS",
       "FIZ/GAR", "TÁVOLIGÉPELÉRÉS"
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const writeCmms = dbs.cmms.transaction(() => {
    insertCmms.run(
      key,
      sorszam,
      reportedAt,
      customerName,
      customer.zip ?? null,
      customer.address ?? null,
      customer.phone ?? null,
      customer.email ?? null,
      reported,
      work || null,
      1, // Phase 3 polarity fix: 1=open
      technician,
      deviceCell || null,
      null,
      "fiz",
      "nincs",
    );
  });
  try {
    writeCmms();
  } catch (e: any) {
    return { ok: false, status: 500, code: "cmms_write_failed", message: String(e?.message ?? e) };
  }

  // Phase 1: run the deterministic classifier on the new ticket's
  // reported + work text + parsed devices. The result is written into
  // the inferred kategoria / sulyossag / alkategoria columns so the
  // ticket is queryable by inferred values from the moment it's
  // created.
  const parsedDevices = parseDeviceCell(deviceCell);
  const cls = classify({
    reported,
    work: work || null,
    devices: parsedDevices.map((d) => ({
      model: d.model,
      controller: d.controller,
      machine_type: d.machine_type,
      raw: d.raw,
    })),
  });

  // Mirror into cmms_specialized.db.
  const writeSpec = dbs.spec.transaction(() => {
    const custRes = dbs.stmts.insertCustomer.run(
      customerName,
      fold(customerName),
      customer.zip ?? null,
      customer.address ?? null,
      fold(customer.address ?? null),
      customer.phone ?? null,
      customer.email ?? null,
    );
    const customerId = Number(custRes.lastInsertRowid);
    dbs.stmts.insertJob.run(
      key,
      sorszam,
      reportedAt,
      reportedAtIso,
      customerId,
      technician,
      0,
      null, // problem_kategoria
      null, // problem_alkategoria
      null, // sulyossag
    );
    for (const d of parsedDevices) {
      dbs.stmts.insertDevice.run(
        key,
        d.raw,
        fold(d.raw),
        d.model,
        d.model_ascii,
        d.software,
        d.hardware,
        d.servos,
        d.controller,
        d.machine_type,
        d.freeform,
      );
    }
    dbs.stmts.insertNote.run(key, "reported", reported, fold(reported), null, reportedAtIso);
    if (work) {
      dbs.stmts.insertNote.run(key, "work", work, fold(work), null, reportedAtIso);
    }
  });
  try {
    writeSpec();
  } catch (e: any) {
    return { ok: false, status: 500, code: "spec_write_failed", message: String(e?.message ?? e) };
  }
  // Force the WAL to be fully merged into the main DB file so that any
  // subsequent reader (including a fresh connection opened by nextSorszam)
  // sees the just-committed row.
  try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}

  // Update cache.
  const card = makeCardFromSpec(dbs, key);
  cache.upsert(card);
  return { ok: true, card };
}

function appendNote(
  dbs: OpenDbs,
  cache: JobCache,
  key: number,
  body: AppendBody,
  nowIso: string,
): { ok: true; card: JobCard } | { ok: false; status: number; code: string; message: string } {
  const kind = body.kind as "reported" | "work" | "free";
  const text = body.body!.trim();
  const author = body.author ?? null;
  const stamp = nowIso.slice(0, 10);
  const line = `-- ${stamp}${author ? " " + author : ""}: ${text}`;

  // Update cmms.db: MEGJEGYZÉS gets appended (always), and BEJELENTETT HIBA /
  // ELVÉGZETT MUNKA are appended with a separator if already non-empty.
  const writeCmms = dbs.cmms.transaction(() => {
    const cur = dbs.cmms
      .prepare(`SELECT "BEJELENTETT HIBA" AS r, "ELVÉGZETT MUNKA" AS w, "MEGJEGYZÉS" AS m FROM data WHERE "KEY" = ?`)
      .get(key) as { r: string | null; w: string | null; m: string | null } | undefined;
    if (!cur) {
      throw new Error("__NOT_FOUND__");
    }
    const col = kind === "reported" ? "BEJELENTETT HIBA" : kind === "work" ? "ELVÉGZETT MUNKA" : "MEGJEGYZÉS";
    const prev = kind === "reported" ? cur.r : kind === "work" ? cur.w : cur.m;
    const next = prev && String(prev).trim() !== "" ? `${prev}\n${line}` : line;
    dbs.cmms.prepare(`UPDATE data SET "${col}" = ? WHERE "KEY" = ?`).run(next, key);
  });
  try {
    writeCmms();
  } catch (e: any) {
    if (e?.message === "__NOT_FOUND__") {
      return { ok: false, status: 404, code: "not_found", message: `row ${key} not in cmms.db` };
    }
    return { ok: false, status: 500, code: "cmms_write_failed", message: String(e?.message ?? e) };
  }

  // Mirror into specialized DB.
  const writeSpec = dbs.spec.transaction(() => {
    dbs.stmts.insertNote.run(key, kind, text, fold(text), author, nowIso);
  });
  try {
    writeSpec();
  } catch (e: any) {
    return { ok: false, status: 500, code: "spec_write_failed", message: String(e?.message ?? e) };
  }
  try { dbs.spec.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch {}

  const card = makeCardFromSpec(dbs, key);
  cache.upsert(card);
  return { ok: true, card };
}
