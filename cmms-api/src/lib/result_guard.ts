// result_guard.ts
//
// Phase 5.2 — Server-side result guard for MCP tool responses.
//
// What this does
// --------------
// After a tool's REST call returns, we look at the LLM-supplied
// identifiers (sorszam, device, customer) and the response body. If the
// response contains hits that DON'T include the asked identifier, the
// LLM is at risk of conflating them and presenting the wrong ticket
// as the answer (e.g. "M09192" question -> citing M11357/M06079).
//
// This guard runs in two stages:
//   1. extractIds(args) pulls the asked identifiers out of the tool args.
//   2. checkResult({ ids, response, tool }) walks the response and
//      produces:
//        - warnings: human-readable strings the LLM must surface.
//        - blocked: true if no hit contains the asked identifier AND
//          at least one hit exists for a *different* identifier. The
//          raw result is then replaced with a canned response so the
//          LLM cannot pass through the wrong data.
//
// Why this exists
// ---------------
// Phase 5.1 fixed two transport bugs (q dropped on device, GET-with-body
// on integration tools) but the M09192 question still produced a wrong
// answer because the LLM called search_serviz_belso with a fuzzy q and
// the top FTS5 hit was M11357/M06079. The LLM didn't notice the
// munkaszam didn't match and paraphrased it as if it were the answer.
//
// Adding the guard on the server side is the only place this can be
// caught reliably — the LLM prompt can ASK the model to verify the
// sorszam, but the server is the only one that can BLOCK the wrong
// result from being returned in the first place.
//
// Scope
// -----
// Today: jobs/search (main DB), jobs/stats (aggregations, less critical),
// all 4 integration search tools, get_serviz_ticket, get_ticket_stats.
// Stats aggregations are skipped when group_by is set (no per-hit
// identity to check). create/modify/close return the affected sorszam
// directly so they're easy to verify — also covered.

export type AskedIds = {
  sorszam?: string; // B\d{7,9}
  m_sorszam?: string; // M\d{4,6} (machine serial in the LLM's parlance)
  device?: string; // M\d{4,6} or model like TMV-400
  customer?: string; // substring from extractCustomer-style logic
  j_szam?: string; // serviz_belso J-sorszam
  munkaszam?: string; // szev_igeny / telephely_munka munkaszam (e.g. M09192)
};

export type GuardResult = {
  warnings: string[];
  blocked: boolean;
  canned?: { language: "hu" | "en"; text: string };
  // When the guard rewrites the body, we keep the original under
  // `original` so a debugging client can still see what came back.
  original?: unknown;
};

const B_SORSZAM_RE = /\bB\d{7,9}\b/i;
const M_SORSZAM_RE = /\bM\d{4,6}\b/;

// -----------------------------------------------------------------------
// extractIds: pull identifiers out of the LLM-supplied tool args.
// -----------------------------------------------------------------------
export function extractIds(args: Record<string, unknown> | undefined): AskedIds {
  const out: AskedIds = {};
  if (!args) return out;
  // search_tickets / search_existing_tickets / answer_question style args
  // can carry a free-text `q` AND a structured `sorszam` / `device` / `customer`.
  const sorszamField = (args.sorszam as string | undefined)?.trim();
  if (sorszamField && B_SORSZAM_RE.test(sorszamField)) {
    out.sorszam = sorszamField.toUpperCase();
  }
  const deviceField = (args.device as string | undefined)?.trim();
  if (deviceField) {
    out.device = deviceField.toUpperCase();
  }
  const customerField = (args.customer as string | undefined)?.trim();
  if (customerField && customerField.length >= 3) {
    out.customer = customerField;
  }
  // For integration tools: j_szam (serviz), munkaszam (szev/telephely)
  const jSzam = (args.j_szam as string | undefined)?.trim();
  if (jSzam) out.j_szam = jSzam;
  const munkaszam = (args.munkaszam as string | undefined)?.trim();
  if (munkaszam) out.munkaszam = munkaszam;
  // Free-text `q` may contain sorszams we should also enforce.
  // We do NOT enforce on every `q` (too noisy) — only when the q
  // contains a B- or M- sorszam that the LLM appears to be asking
  // about. Heuristic: if `q` has a B- or M- pattern AND no other
  // identifier was already extracted, treat the q's sorszam as the
  // asked one.
  const q = (args.q as string | undefined)?.trim() ?? "";
  if (q) {
    const bMatch = q.match(B_SORSZAM_RE);
    if (bMatch && !out.sorszam) out.sorszam = bMatch[0].toUpperCase();
    const mMatch = q.match(M_SORSZAM_RE);
    if (mMatch && !out.m_sorszam && !out.device) {
      // Heuristic: M\d{4,6} could be a machine serial OR a M-prefixed
      // sorszam. We capture it as m_sorszam so the guard can compare
      // against the response's munkaszam field for integration tools.
      out.m_sorszam = mMatch[0].toUpperCase();
    }
  }
  return out;
}

// -----------------------------------------------------------------------
// Normalize for comparison
// -----------------------------------------------------------------------
function norm(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[-\s]/g, "");
}

// -----------------------------------------------------------------------
// Per-response check: does any hit contain the asked identifier?
// -----------------------------------------------------------------------
type Hit = Record<string, any>;

function hitsContainSorszam(hits: Hit[], asked: string): boolean {
  const n = norm(asked);
  return hits.some((h) => {
    // Main DB: top-level sorszam
    if (typeof h.sorszam === "string" && norm(h.sorszam) === n) return true;
    // Main DB sometimes nests under job.sorszam (search hits)
    if (h.job && typeof h.job.sorszam === "string" && norm(h.job.sorszam) === n) return true;
    // Integration: j_szam / munkaszam
    if (typeof h.j_szam === "string" && norm(h.j_szam) === n) return true;
    if (typeof h.munkaszam === "string" && norm(h.munkaszam) === n) return true;
    return false;
  });
}

function hitsContainMSorszam(hits: Hit[], asked: string): boolean {
  const n = norm(asked);
  return hits.some((h) => {
    if (typeof h.munkaszam === "string" && norm(h.munkaszam) === n) return true;
    if (typeof h.sorszam === "string" && norm(h.sorszam) === n) return true;
    return false;
  });
}

function hitsContainJSzam(hits: Hit[], asked: string): boolean {
  const n = norm(asked);
  return hits.some((h) => {
    if (typeof h.j_szam === "string" && norm(h.j_szam) === n) return true;
    return false;
  });
}

function hitsContainMunkaszam(hits: Hit[], asked: string): boolean {
  const n = norm(asked);
  return hits.some((h) => {
    if (typeof h.munkaszam === "string" && norm(h.munkaszam) === n) return true;
    return false;
  });
}

function hitsContainDevice(hits: Hit[], asked: string): boolean {
  const n = norm(asked);
  return hits.some((h) => {
    const devs: any[] = [];
    if (h.devices) devs.push(...h.devices);
    if (h.job?.devices) devs.push(...h.job.devices);
    if (h.eszkoz) devs.push({ raw: h.eszkoz });
    for (const d of devs) {
      const m = norm(d.model ?? "") || norm(d.raw ?? "");
      if (m && (m.includes(n) || n.includes(m))) return true;
    }
    return false;
  });
}

function hitsContainCustomer(hits: Hit[], asked: string): boolean {
  const n = asked.toLowerCase();
  return hits.some((h) => {
    const c = (h.customer?.name ?? h.cegnev ?? h.megrendelo ?? h.job?.customer?.name ?? "").toLowerCase();
    if (!c) return false;
    // Bidirectional substring: "ANDRITZ" matches "ANDRITZ Kft." and
    // "ANDRITZ KFT." matches "ANDRITZ".
    return c.includes(n) || n.includes(c);
  });
}

// -----------------------------------------------------------------------
// Main entry: checkResult({ ids, response, tool })
// -----------------------------------------------------------------------
export function checkResult(args: {
  ids: AskedIds;
  response: unknown;
  tool: string;
  language?: "hu" | "en";
}): GuardResult {
  const warnings: string[] = [];
  const { ids, response, tool } = args;
  const language = args.language ?? "hu";
  // No ids to check -> nothing to guard.
  if (!ids.sorszam && !ids.m_sorszam && !ids.j_szam && !ids.munkaszam && !ids.device && !ids.customer) {
    return { warnings, blocked: false };
  }
  // Response is not the expected shape (e.g. error). Don't block; the
  // call already surfaced the failure.
  if (!response || typeof response !== "object") {
    return { warnings, blocked: false };
  }
  const r = response as Record<string, any>;
  // Stats / aggregations don't have per-hit identity. Skip the
  // check; the LLM can still cite counts.
  if (tool === "get_ticket_stats" || tool === "get_failure_rates" || tool === "get_integration_stats") {
    return { warnings, blocked: false };
  }
  // Pull hits out of the response. Different tools use different
  // field names.
  const hits: Hit[] =
    r.jobs ?? r.results ?? r.timeline ?? r.entries ?? r.hubs ?? [];
  if (!Array.isArray(hits) || hits.length === 0) {
    // Empty result is fine; the LLM will report "no matches".
    return { warnings, blocked: false };
  }
  // Total asked = at least one identity field. We require EACH asked
  // identity field to be present in some hit. If any field is missing,
  // it's a mismatch.
  const missingSorszam = ids.sorszam && !hitsContainSorszam(hits, ids.sorszam);
  const missingMSorszam = ids.m_sorszam && !hitsContainMSorszam(hits, ids.m_sorszam);
  const missingJSzam = ids.j_szam && !hitsContainJSzam(hits, ids.j_szam);
  const missingMunkaszam = ids.munkaszam && !hitsContainMunkaszam(hits, ids.munkaszam);
  const missingDevice = ids.device && !hitsContainDevice(hits, ids.device);
  const missingCustomer = ids.customer && !hitsContainCustomer(hits, ids.customer);

  const asked: string[] = [];
  if (ids.sorszam) asked.push(`sorszam=${ids.sorszam}`);
  if (ids.m_sorszam) asked.push(`m_sorszam=${ids.m_sorszam}`);
  if (ids.j_szam) asked.push(`j_szam=${ids.j_szam}`);
  if (ids.munkaszam) asked.push(`munkaszam=${ids.munkaszam}`);
  if (ids.device) asked.push(`device=${ids.device}`);
  if (ids.customer) asked.push(`customer=${ids.customer}`);

  if (!missingSorszam && !missingMSorszam && !missingJSzam && !missingMunkaszam && !missingDevice && !missingCustomer) {
    // All good.
    return { warnings, blocked: false };
  }

  // Build the warning text. Show what the LLM asked for vs. what the
  // top hits actually contain, so the model can decide what to do.
  const topHitSummary = hits.slice(0, 3).map((h) => {
    const s = h.sorszam ?? h.munkaszam ?? h.j_szam ?? "?";
    const c = h.customer?.name ?? h.cegnev ?? h.megrendelo ?? "?";
    return `${s} (${c})`;
  });
  const askedStr = asked.join(", ");
  const warning = language === "hu"
    ? `⚠ Figyelem: a kérés (${askedStr}) nem szerepel a találatok között. A felső 3 találat: ${topHitSummary.join(", ")}. Csak akkor idézd, ha a felhasználó elfogadja a legközelebbi találatot.`
    : `⚠ The asked identifier (${askedStr}) is not in the results. Top 3 hits: ${topHitSummary.join(", ")}. Only cite if the user accepts the closest match.`;

  // Block: there ARE results, but NONE of them match the asked
  // identifier. Returning the raw data here is exactly what causes
  // confabulation. Replace with a canned response.
  const cannedText = language === "hu"
    ? `Nem találtam a kéréshez (${askedStr}) tartozó bejegyzést. A szerver ${hits.length} találatot adott, de egyik sem illeszkedik a megadott azonosítóra. Legközelebbi találatok: ${topHitSummary.join(", ")}. Kérdezd meg a felhasználót, hogy ezek közül valamelyiket szeretné-e látni, vagy pontosítsa a keresést.`
    : `No record found matching the request (${askedStr}). The server returned ${hits.length} results, none of which match the asked identifier. Closest matches: ${topHitSummary.join(", ")}. Ask the user if they want to see one of these, or to narrow the search.`;

  return {
    warnings: [warning],
    blocked: true,
    canned: { language, text: cannedText },
    original: response,
  };
}
