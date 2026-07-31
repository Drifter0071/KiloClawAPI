// /v1/capabilities
//
// Designed to be the first thing the AI agent calls after handshake.
// Returns: server identity, auth model, every endpoint, every request
// field with type and meaning, every response field, and copy-pasteable
// examples. The goal is that the agent can plan any operation without
// reading source code.
import type { Router } from "express";
import { Router as makeRouter } from "express";

const CAPABILITIES = {
  server: {
    name: "cmms-api",
    version: "0.4.0",
    purpose:
      "Read and append to a CMMS (Computerized Maintenance Management System) database. Built for a cloud AI agent to assist on-the-ground maintenance workers by finding similar past jobs and logging new ones.",
    language: "MCP tool descriptions are bilingual (hu + en). Free-text fields in the database are Hungarian; diacritic-folded ASCII search works (e.g. 'tavoli' matches 'távoli').",
  },
  auth: {
    scheme: "Bearer token in the `Authorization` header.",
    tokens: {
      read: "CMMS_API_TOKEN_READ. Required for every endpoint except /v1/health.",
      write: "CMMS_API_TOKEN_WRITE. Required in addition to (or instead of) the read token for any POST endpoint that creates a job or appends a note.",
    },
    error_codes: {
      "401": "Missing or invalid bearer token.",
      "403": "Read-only token used on a write endpoint.",
      "503": "Server is running with read token only (no write token configured).",
    },
  },
  conventions: {
    ids: "Every job has an integer `key` (the original sheet's KEY column, 1..N) and a string `sorszam` (legacy id like 'B00110601' or 'B240326002').",
    dates: "Date filters use 'YYYY-MM-DD'. The original sheet uses 'YYYY.MM.DD'.",
    pagination: "Search returns up to `limit` hits (default 20, max 100). No cursor-based pagination; the cache is small enough that clients can page by re-querying with date filters.",
    errors: "All errors are JSON: { error: { code: string, message: string } }.",
    no_update_no_delete: "Existing jobs and notes cannot be modified or deleted. Only append. There is no raw SQL endpoint.",
  },
  endpoints: [
    {
      method: "GET",
      path: "/v1/health",
      auth: "none",
      description: "Liveness + ETL info. Call this first to confirm the server is up.",
      response: {
        ok: "boolean, always true if the server is responding",
        etl_mtime: "number, ms since epoch of the last ETL pass, null if never run",
        jobs: "number, count of jobs in the in-memory cache",
        cmms_path: "string, absolute path to cmms.db the server is using",
      },
      example_response: { ok: true, etl_mtime: 1716000000000, jobs: 65907, cmms_path: "/var/lib/cmms/cmms.db" },
    },
    {
      method: "GET",
      path: "/v1/capabilities",
      auth: "read",
      description: "This document. Call once on connection to learn the full API surface.",
      response: "this object",
    },
    {
      method: "GET",
      path: "/v1/schema",
      auth: "read",
      description: "Frozen English-language description of the three priority fields, the JobCard shape, and endpoint list. Read once for human-readable docs; use /v1/capabilities for machine-readable.",
      response: "JSON object (see src/schema/schema.json)",
    },
    {
      method: "GET",
      path: "/v1/index",
      auth: "read",
      description: "Top-N distinct values to ground answers (which customers exist, which device models are common, which technicians are referenced).",
      response: {
        totalJobs: "number",
        statusCounts: { open: "number", closed: "number" },
        topCustomers: "array of { name, count } sorted by count desc, capped at 200",
        topModels: "array of { name, count } sorted by count desc, capped at 200",
        topTechnicians: "array of { name, count } sorted by count desc, capped at 200",
      },
    },
    {
      method: "POST",
      path: "/v1/jobs/search",
      auth: "read",
      description:
        "Search jobs. All body fields are optional. The free-text `q` is matched against devices, customer name+address, and notes (reported, work, free). Tokens are AND-matched with diacritic-folded substring.",
      request: {
        q: "string, optional. Free text. AND-of-tokens, diacritic-folded, case-insensitive, matched against devices.raw, devices.model, customer.name, customer.address, and all notes. Bonus score for matches in the three priority fields.",
        customer: "string, optional. Substring (case-insensitive) on customer name.",
        device: "string, optional. Substring (case-insensitive) on any device.raw or device.model.",
        status: "string, optional. 'open' (NY/Z=1) or 'closed' (NY/Z=0). [Phase 3 polarity fix: 2026-07-31]",
        date_from: "string, optional. YYYY-MM-DD. Includes jobs with reported_at_iso >= date_from.",
        date_to: "string, optional. YYYY-MM-DD. Includes jobs with reported_at_iso <= date_to.",
        limit: "number, optional, default 20, max 100. Number of hits to return.",
      },
      response: {
        total: "number, length of `jobs` (capped at limit).",
        jobs: "array of JobCard objects ranked by relevance (q match score, then most recent first).",
      },
      examples: [
        { request: { q: "TMV-400", limit: 3 }, note: "Find past TMV-400 jobs to copy the fix from." },
        { request: { q: "távoli gépelés" }, note: "Hungarian phrase, diacritics folded. Use the ASCII form 'tavoli gepeles' if you prefer." },
        { request: { device: "NCT2000", status: "open" }, note: "All open jobs involving an NCT2000 device." },
        { request: { customer: "GE" }, note: "All jobs for customers whose name contains 'GE'." },
        { request: { date_from: "2025-01-01", date_to: "2025-12-31", limit: 50 }, note: "All jobs in 2025." },
      ],
    },
    {
      method: "GET",
      path: "/v1/jobs/:key",
      auth: "read",
      description: "Full JobCard for a single job by integer key. Returns 404 if not in the cache.",
      response: "JobCard (see /v1/schema)",
    },
    {
      method: "GET",
      path: "/v1/jobs/:key/raw",
      auth: "read",
      description:
        "The untouched original row from cmms.db by KEY. Use this when the JobCard does not include a field you need (e.g. the 30+ non-priority columns like FIZ/GAR, GARANCIA dates, technician's image links, the VS MEO subsystem columns, etc).",
      response: "raw row object, same shape as the source sheet's `data` table",
    },
    {
      method: "POST",
      path: "/v1/jobs",
      auth: "write",
      description:
        "Create a new job. Writes to cmms.db first, then mirrors into the specialized DB, then updates the in-memory cache. The new job's sorszam is auto-generated in B-YYYYMM-### format, matching the legacy scheme.",
      request: {
        customer: {
          name: "string, required. Current customer name.",
          zip: "string, optional.",
          address: "string, optional.",
          phone: "string, optional.",
          email: "string, optional.",
        },
        devices: "array of strings, optional but recommended. Each string is parsed the same way the original sheet parses them (semicolon-separated, with model(...) groups, SW-..., HW:..., Servok:... hints). One row per device is stored.",
        reported: "string, required. The fault as reported (BEJELENTETT HIBA).",
        work: "string, optional. If you already know how it was fixed, record it (ELVÉGZETT MUNKA).",
        technician: "string, optional. Technician initials or name (DOLGOZÓ).",
      },
      response: "JobCard of the newly created job (201 Created).",
      example_request: {
        customer: { name: "MÁV RT. Debrecen", zip: "4034", address: "Debrecen Faraktár u 107" },
        devices: ["TMV-400(10297;M10170);NCT99M;CRT15\"", "SW-1.039"],
        reported: "készülék nem indul",
        technician: "TP",
      },
    },
    {
      method: "POST",
      path: "/v1/jobs/:key/notes",
      auth: "write",
      description:
        "Append a note to an existing job. Mirrored to cmms.db: kind='reported' or 'work' appends to BEJELENTETT HIBA / ELVÉGZETT MUNKA with a '\\n-- YYYY-MM-DD author: body' separator; kind='free' appends to MEGJEGYZÉS the same way.",
      request: {
        kind: "string, required. One of 'reported' (the original fault), 'work' (what the technician did), 'free' (any other note).",
        body: "string, required. The note text.",
        author: "string, optional. Who wrote it.",
      },
      response: "JobCard of the job after the note was appended (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets",
      auth: "write",
      description: "Open a new maintenance ticket. Requires only customer_name. Returns the new ticket with auto-generated key and sorszam.",
      request: {
        customer_name: "string, required.",
        customer_zip: "string, optional.",
        customer_address: "string, optional.",
        customer_phone: "string, optional.",
        customer_email: "string, optional.",
      },
      response: "JobCard (201 Created). Fields like problem, devices, technician are empty — use the setter endpoints to fill them in.",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/problem",
      auth: "write",
      description: "Set or append the problem description (BEJELENTETT HIBA).",
      request: { text: "string, required." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/machine",
      auth: "write",
      description: "Set the device/equipment list. Replaces existing devices.",
      request: { devices: "array of strings, required. Each is a device identifier." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/location",
      auth: "write",
      description: "Set address and postal code.",
      request: { address: "string, required.", zip: "string, optional." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/phone",
      auth: "write",
      description: "Set phone number.",
      request: { phone: "string, required." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/email",
      auth: "write",
      description: "Set email address.",
      request: { email: "string, required." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/reporter",
      auth: "write",
      description: "Set who reported the fault and optionally who received the report.",
      request: { reporter: "string, required.", fault_receiver: "string, optional." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/technician",
      auth: "write",
      description: "Assign a technician to the ticket.",
      request: { technician: "string, required." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/solution",
      auth: "write",
      description: "Record what was done to fix the issue (ELVÉGZETT MUNKA).",
      request: { text: "string, required.", author: "string, optional." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/payment",
      auth: "write",
      description: "Set payment/warranty status.",
      request: { payment: "string, required. 'fiz' (paid) or 'gar' (warranty)." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/remote-access",
      auth: "write",
      description: "Set remote access info.",
      request: { remote_access: "string, required." },
      response: "Updated JobCard (201 Created).",
    },
    {
      method: "POST",
      path: "/v1/tickets/:key/close",
      auth: "write",
      description: "Mark a ticket as closed (NY/Z = 0). [Phase 3 polarity fix: 2026-07-31]",
      request: {},
      response: "Updated JobCard (201 Created) with status='closed'.",
    },
    {
      method: "POST",
      path: "/v1/tickets/modify",
      auth: "write",
      description: "Modify any field on a ticket by sorszam. Only provided fields are changed.",
      request: {
        sorszam: "string, required.",
        customer_name: "string, optional.",
        customer_zip: "string, optional.",
        customer_address: "string, optional.",
        customer_phone: "string, optional.",
        customer_email: "string, optional.",
        device: "array of strings or semicolon-separated string, optional.",
        reported: "string, optional — appends a reported note.",
        work: "string, optional — appends a work note.",
        technician: "string, optional.",
        reporter: "string, optional.",
        fault_receiver: "string, optional.",
        payment: "string, optional — 'fiz' or 'gar'.",
        remote_access: "string, optional.",
        status: "string, optional — 'open' or 'closed'.",
      },
      response: "Updated JobCard (200 OK).",
    },
    {
      method: "GET",
      path: "/v1/tickets/recent",
      auth: "read",
      description: "Get recent tickets within a time range, sorted newest first.",
      request: {
        hours: "number, optional, default 24, max 720.",
        limit: "number, optional, default 50, max 100.",
        status: "string, optional — 'open' or 'closed'.",
      },
      response: "{ total: number, jobs: JobCard[] }",
    },
    {
      method: "GET",
      path: "/v1/tickets/recent-with-solution",
      auth: "read",
      description: "Get recent tickets that have a recorded solution (work note). Default last 7 days.",
      request: {
        hours: "number, optional, default 168, max 720.",
        limit: "number, optional, default 20, max 100.",
      },
      response: "{ total: number, jobs: JobCard[] }",
    },
  ],
  priority_fields: {
    description: "These are the three fields that matter most for helping workers fix issues. Prefer them in answers.",
    fields: [
      { path: "jobs[].devices[].raw", hu: "Készülék típusa", example: "TMV-400(10297;M10170);NCT99M;CRT15\";SW-1.039" },
      { path: "jobs[].notes[kind=reported].body", hu: "Bejelentett hiba", example: "készülék nem indul" },
      { path: "jobs[].notes[kind=work].body", hu: "Elvégzett munka", example: "SW frissítés 1.039-re, kábel csere" },
    ],
  },
  typical_workflows: [
    {
      name: "Help a worker fix a known fault",
      steps: [
        "GET /v1/capabilities (once, on connection)",
        "GET /v1/index (to learn top customers/models)",
        "POST /v1/jobs/search with { q: <device model or fault text>, limit: 10 }",
        "For each promising hit, GET /v1/jobs/:key to read its full notes",
        "Summarize the most relevant past 'work' notes for the worker",
      ],
    },
    {
      name: "Log a new job reported by a worker",
      steps: [
        "POST /v1/jobs with { customer, devices, reported, technician }",
        "Capture the returned key",
        "Later, POST /v1/jobs/:key/notes with { kind: 'work', body, author } when the job is done",
      ],
    },
    {
      name: "Look up a job by its legacy sorszam",
      steps: [
        "POST /v1/jobs/search with { q: 'B240326002' } (the sorszam is part of the haystack)",
        "Find the hit, GET /v1/jobs/:key for full details",
      ],
    },
  ],
} as const;

export function capabilitiesRouter(): Router {
  const r = makeRouter();
  r.get("/v1/capabilities", (_req, res) => {
    res.json(CAPABILITIES);
  });
  return r;
}
