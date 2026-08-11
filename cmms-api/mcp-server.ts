// MCP server that wraps the cmms-api REST endpoints into proper MCP tools.
//
// Two transport modes are supported, selected by MCP_TRANSPORT env var:
//   stdio (default)       - stdin/stdout, for local clients (e.g. Kilo)
//   http                  - Streamable HTTP on MCP_PORT (default 8788),
//                          for remote clients behind a tunnel
//
// Env vars (loaded from .env by Bun):
//   CMMS_API_URL          - base URL of the REST API (default http://127.0.0.1:8787)
//   CMMS_API_TOKEN_READ   - bearer token for read endpoints (required)
//   CMMS_API_TOKEN_WRITE  - bearer token for write endpoints (optional)
//   MCP_TRANSPORT         - "stdio" (default) or "http"
//   MCP_PORT              - HTTP port when MCP_TRANSPORT=http (default 8788)
//   MCP_HOST              - HTTP host when MCP_TRANSPORT=http (default 127.0.0.1)
//   MCP_BEARER_TOKEN      - if set, HTTP transport requires this bearer token
//                            in the Authorization header (recommended for tunnel)
//
// Phase 0 redesign (mcp-redesign phase 0):
//   - Bilingual (hu + en) tool descriptions so the LLM doesn't have to
//     translate between the user's question language and English metadata.
//   - `period` parameter on every search/stats tool — server-side
//     resolution of "this_month" / "last 30 days" / "tavaly" / etc.
//     into concrete ISO dates, with bilingual echo.
//   - `include_evidence` (default ON) on get_ticket_stats — every top
//     result ships 1-2 sample sorszam + snippet so the answer can cite.
//   - `language` parameter (hu|en) where it matters; defaults to "en"
//     for backwards compatibility with KiloClaw prompts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// --- Config from environment ---

const BASE = process.env.CMMS_API_URL ?? "http://127.0.0.1:8787";
const READ_TOKEN = process.env.CMMS_API_TOKEN_READ ?? "";
const WRITE_TOKEN = process.env.CMMS_API_TOKEN_WRITE ?? "";
const TRANSPORT = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
const HTTP_PORT = Number(process.env.MCP_PORT ?? 8788);
const HTTP_HOST = process.env.MCP_HOST ?? "127.0.0.1";
const HTTP_BEARER = process.env.MCP_BEARER_TOKEN ?? "";

if (!READ_TOKEN) {
  console.error(
    "CMMS_API_TOKEN_READ is not set. The MCP server needs a read token to talk to cmms-api.",
  );
}

// --- HTTP helper ---

// Phase 5.2: result_guard is inlined here because deploy-mcp.ts
// doesn't upload the src/ directory. The standalone
// cmms-api/src/lib/result_guard.ts is kept for unit tests (the test
// file imports it directly); both copies must stay in sync.
type AskedIds = {
  sorszam?: string;
  m_sorszam?: string;
  device?: string;
  customer?: string;
  j_szam?: string;
  munkaszam?: string;
};
type GuardResult = {
  warnings: string[];
  blocked: boolean;
  canned?: { language: "hu" | "en"; text: string };
  original?: unknown;
};
const _B_SORSZAM_RE = /\bB\d{7,9}\b/i;
const _M_SORSZAM_RE = /\bM\d{4,6}\b/;
function _norm(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[-\s]/g, "");
}
function _extractIds(args: Record<string, unknown> | undefined): AskedIds {
  const out: AskedIds = {};
  if (!args) return out;
  const sorszamField = (args.sorszam as string | undefined)?.trim();
  if (sorszamField && _B_SORSZAM_RE.test(sorszamField)) out.sorszam = sorszamField.toUpperCase();
  const deviceField = (args.device as string | undefined)?.trim();
  if (deviceField) out.device = deviceField.toUpperCase();
  const customerField = (args.customer as string | undefined)?.trim();
  if (customerField && customerField.length >= 3) out.customer = customerField;
  const jSzam = (args.j_szam as string | undefined)?.trim();
  if (jSzam) out.j_szam = jSzam;
  const munkaszam = (args.munkaszam as string | undefined)?.trim();
  if (munkaszam) out.munkaszam = munkaszam;
  const q = (args.q as string | undefined)?.trim() ?? "";
  if (q) {
    const bMatch = q.match(_B_SORSZAM_RE);
    if (bMatch && !out.sorszam) out.sorszam = bMatch[0].toUpperCase();
    const mMatch = q.match(_M_SORSZAM_RE);
    if (mMatch && !out.m_sorszam && !out.device) out.m_sorszam = mMatch[0].toUpperCase();
  }
  return out;
}
function _hitsContainSorszam(hits: any[], asked: string): boolean {
  const n = _norm(asked);
  return hits.some((h) => {
    if (typeof h.sorszam === "string" && _norm(h.sorszam) === n) return true;
    if (h.job && typeof h.job.sorszam === "string" && _norm(h.job.sorszam) === n) return true;
    if (typeof h.j_szam === "string" && _norm(h.j_szam) === n) return true;
    if (typeof h.munkaszam === "string" && _norm(h.munkaszam) === n) return true;
    return false;
  });
}
function _hitsContainMSorszam(hits: any[], asked: string): boolean {
  const n = _norm(asked);
  return hits.some((h) => {
    if (typeof h.munkaszam === "string" && _norm(h.munkaszam) === n) return true;
    if (typeof h.sorszam === "string" && _norm(h.sorszam) === n) return true;
    return false;
  });
}
function _hitsContainJSzam(hits: any[], asked: string): boolean {
  const n = _norm(asked);
  return hits.some((h) => typeof h.j_szam === "string" && _norm(h.j_szam) === n);
}
function _hitsContainMunkaszam(hits: any[], asked: string): boolean {
  const n = _norm(asked);
  return hits.some((h) => typeof h.munkaszam === "string" && _norm(h.munkaszam) === n);
}
function _hitsContainDevice(hits: any[], asked: string): boolean {
  const n = _norm(asked);
  return hits.some((h) => {
    const devs: any[] = [];
    if (h.devices) devs.push(...h.devices);
    if (h.job?.devices) devs.push(...h.job.devices);
    if (h.eszkoz) devs.push({ raw: h.eszkoz });
    for (const d of devs) {
      const m = _norm(d.model ?? "") || _norm(d.raw ?? "");
      if (m && (m.includes(n) || n.includes(m))) return true;
    }
    return false;
  });
}
function _hitsContainCustomer(hits: any[], asked: string): boolean {
  const n = asked.toLowerCase();
  return hits.some((h) => {
    const c = (h.customer?.name ?? h.cegnev ?? h.megrendelo ?? h.job?.customer?.name ?? "").toLowerCase();
    if (!c) return false;
    return c.includes(n) || n.includes(c);
  });
}
function _checkResult(args: { ids: AskedIds; response: unknown; tool: string; language?: "hu" | "en" }): GuardResult {
  const { ids, response, tool } = args;
  const language = args.language ?? "hu";
  const warnings: string[] = [];
  if (!ids.sorszam && !ids.m_sorszam && !ids.j_szam && !ids.munkaszam && !ids.device && !ids.customer) {
    return { warnings, blocked: false };
  }
  if (!response || typeof response !== "object") return { warnings, blocked: false };
  const r = response as Record<string, any>;
  if (tool === "get_ticket_stats" || tool === "get_failure_rates" || tool === "get_integration_stats") {
    return { warnings, blocked: false };
  }
  const hits: any[] = r.jobs ?? r.results ?? r.timeline ?? r.entries ?? r.hubs ?? [];
  if (!Array.isArray(hits) || hits.length === 0) return { warnings, blocked: false };
  const missingSorszam = ids.sorszam && !_hitsContainSorszam(hits, ids.sorszam);
  const missingMSorszam = ids.m_sorszam && !_hitsContainMSorszam(hits, ids.m_sorszam);
  const missingJSzam = ids.j_szam && !_hitsContainJSzam(hits, ids.j_szam);
  const missingMunkaszam = ids.munkaszam && !_hitsContainMunkaszam(hits, ids.munkaszam);
  const missingDevice = ids.device && !_hitsContainDevice(hits, ids.device);
  const missingCustomer = ids.customer && !_hitsContainCustomer(hits, ids.customer);
  const asked: string[] = [];
  if (ids.sorszam) asked.push(`sorszam=${ids.sorszam}`);
  if (ids.m_sorszam) asked.push(`m_sorszam=${ids.m_sorszam}`);
  if (ids.j_szam) asked.push(`j_szam=${ids.j_szam}`);
  if (ids.munkaszam) asked.push(`munkaszam=${ids.munkaszam}`);
  if (ids.device) asked.push(`device=${ids.device}`);
  if (ids.customer) asked.push(`customer=${ids.customer}`);
  if (!missingSorszam && !missingMSorszam && !missingJSzam && !missingMunkaszam && !missingDevice && !missingCustomer) {
    return { warnings, blocked: false };
  }
  const topHitSummary = hits.slice(0, 3).map((h) => {
    const s = h.sorszam ?? h.munkaszam ?? h.j_szam ?? "?";
    const c = h.customer?.name ?? h.cegnev ?? h.megrendelo ?? "?";
    return `${s} (${c})`;
  });
  const askedStr = asked.join(", ");
  const warning = language === "hu"
    ? `⚠ Figyelem: a kérés (${askedStr}) nem szerepel a találatok között. A felső 3 találat: ${topHitSummary.join(", ")}. Csak akkor idézd, ha a felhasználó elfogadja a legközelebbi találatot.`
    : `⚠ The asked identifier (${askedStr}) is not in the results. Top 3 hits: ${topHitSummary.join(", ")}. Only cite if the user accepts the closest match.`;
  const cannedText = language === "hu"
    ? `Nem találtam a kéréshez (${askedStr}) tartozó bejegyzést. A szerver ${hits.length} találatot adott, de egyik sem illeszkedik a megadott azonosítóra. Legközelebbi találatok: ${topHitSummary.join(", ")}. Kérdezd meg a felhasználót, hogy ezek közül valamelyiket szeretné-e látni, vagy pontosítsa a keresést.`
    : `No record found matching the request (${askedStr}). The server returned ${hits.length} results, none of which match the asked identifier. Closest matches: ${topHitSummary.join(", ")}. Ask the user if they want to see one of these, or to narrow the search.`;
  return { warnings: [warning], blocked: true, canned: { language, text: cannedText }, original: response };
}

type FetchOpts = { method?: string; body?: unknown; token?: string };

async function call<T = any>(path: string, opts: FetchOpts = {}): Promise<T> {
  const token = opts.token ?? READ_TOKEN;
  const method = (opts.method ?? "GET").toUpperCase();
  // Body methods carry a JSON body. GET/HEAD/OPTIONS must NOT carry a body
  // (Node fetch() rejects with "fetch() request with GET/HEAD/OPTIONS
  // method cannot have body"), so we serialize the body into a query
  // string for those methods. The 5 /v1/integration/.../search routes
  // are r.get() + req.query, so this is the right path anyway.
  const useBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const url = useBody
    ? `${BASE}${path}`
    : (() => {
        let qs = "";
        if (opts.body && typeof opts.body === "object") {
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(opts.body as Record<string, unknown>)) {
            if (v === undefined || v === null || v === "") continue;
            // Arrays become repeated keys (e.g. status=open&status=closed).
            // Objects / nested structures: stringify so the receiver can parse.
            if (Array.isArray(v)) {
              for (const item of v) {
                if (item === undefined || item === null) continue;
                params.append(k, typeof item === "string" ? item : JSON.stringify(item));
              }
            } else if (typeof v === "object") {
              params.append(k, JSON.stringify(v));
            } else {
              params.append(k, String(v));
            }
          }
          const s = params.toString();
          if (s) qs = (path.includes("?") ? "&" : "?") + s;
        }
        return `${BASE}${path}${qs}`;
      })();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(useBody ? { "content-type": "application/json" } : {}),
      },
      body: useBody && opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

// --- Guarded call wrapper ---
//
// Phase 5.2: every tool response goes through result_guard before
// being returned to the LLM. The guard extracts the asked identifiers
// (sorszam / device / customer) from the tool's args, inspects the
// response, and either:
//   - lets the raw response through,
//   - appends a warning the LLM must surface, or
//   - REPLACES the response with a canned "no match" message so the
//     LLM cannot pass through data that doesn't contain the asked
//     identifier (the M09192 -> M11357/M06079 confabulation case).
//
// Bypass: tools that don't take identifiers or don't return hits
// (e.g. /v1/categories, /v1/tags) pass through unchanged.

async function guardedCall<T = any>(
  path: string,
  opts: FetchOpts & { tool: string; args?: Record<string, unknown> } & { language?: "hu" | "en" },
): Promise<T> {
  const data = await call<T>(path, opts);
  const ids = _extractIds(opts.args);
  const guard = _checkResult({ ids, response: data, tool: opts.tool, language: opts.language });
  if (!guard.blocked) return data;
  // Replace the body with the canned response. The original is kept
  // under `original` so a debugging client can still see what came
  // back; the LLM only sees the canned text.
  const cannedBody = {
    _guard: "blocked",
    message: guard.canned?.text,
    warning: guard.warnings[0],
    original: data,
  };
  return cannedBody as unknown as T;
}

// --- Shared schemas ---
//
// period accepts both English tokens ("this_month", "last_30_days") and
// Hungarian aliases ("ebben a hónapban", "utolsó 30 nap"). The server
// resolves to ISO dates; the response echoes the resolved window.

const periodEnum = z.enum([
  "today", "yesterday",
  "this_week", "last_week",
  "this_month", "last_month",
  "this_quarter", "last_quarter",
  "this_year", "last_year",
  "YTD",
  "last_7_days", "last_30_days", "last_90_days", "last_365_days",
  "all", "custom",
]).optional().describe(
  "Date window preset. Server resolves to ISO date_from/date_to. " +
  "English: this_month, last_30_days, last_year, etc. " +
  "Hungarian aliases accepted too: 'ma' (today), 'tavaly' (last year), " +
  "'utolsó 30 nap' (last 30 days), 'múlt hónap' (last month), etc. " +
  "When set, takes priority over date_from/date_to unless period=custom.",
);

const languageEnum = z.enum(["hu", "en"]).optional().describe(
  "Preferred language for human-readable fields in the response " +
  "(label_hu vs label_en in the period echo, status_label_hu vs _en on " +
  "SZÉV, etc.). Defaults to 'en' for backwards compatibility.",
);

// --- MCP Server factory (one McpServer instance per session) ---

function createServer(): McpServer {
  const s = new McpServer({
    name: "cmms-api",
    version: "0.6.0",
  });
  registerTools(s);
  return s;
}

function registerTools(server: McpServer) {

// ---------------------------------------------------------------------------
// Tool 1: search_existing_tickets
// ---------------------------------------------------------------------------
//
// Bilingual description. Bilingual period aliases accepted by the server.
// Evidence in the response (`period` echo) tells the LLM which window was
// actually used so the answer can cite it.
server.registerTool(
  "answer_question",
  {
    title: "Search Existing Tickets / Jegy keresés",
    description: [
      "EN: Search for existing maintenance tickets by free text or filters.",
      "Use for: duplicate detection before creating a ticket; finding a",
      "ticket by customer, device, or keyword; checking if a customer has",
      "an open ticket; looking up past work on a specific device or issue.",
      "DO NOT USE for counting/ranking/aggregation — use get_ticket_stats.",
      "",
      "HU: Meglévő szerviz jegyek keresése szabad szöveggel vagy szűrőkkel.",
      "Használd: duplikátum-ellenőrzéshez, jegy kereséséhez (ügyfél, gép,",
      "kulcsszó), nyitott jegy ellenőrzéséhez, korábbi javítás áttekintéséhez.",
      "NE HASZNÁLD számolás/rangsor/aggregáció helyett — ott get_ticket_stats.",
      "",
      "Period presets (English) / Időszak preset-ek (magyar):",
      "  this_month / ebben a hónapban",
      "  last_month / múlt hónap",
      "  this_year  / idén",
      "  last_year  / tavaly",
      "  YTD        / év eleje óta",
      "  last_30_days / utolsó 30 nap",
      "  last_90_days / utolsó 90 nap",
      "  all        / minden",
      "",
      "If both `period` and `date_from/date_to` are supplied, period wins",
      "unless period='custom' (in which case the explicit dates are used).",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text search (AND-of-tokens, diacritic-folded, case-insensitive)"),
      customer: z.string().optional().describe("Substring match on customer name"),
      device: z.string().optional().describe("Substring match on device raw or model"),
      status: z.enum(["open", "closed"]).optional().describe("Filter by job status"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound (used when period=custom or omitted)"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound (used when period=custom or omitted)"),
      period: periodEnum,
      notes_contains: z.string().optional().describe("Substring match on note text body (diacritic-folded)"),
      kategoria: z.string().optional().describe("Substring match on issue category (problem_kategoria)"),
      sulyossag: z.string().optional().describe("Exact match on severity (alacsony/kozepes/magas/kritikus)"),
      controller: z.string().optional().describe("Substring match on device controller (vezerlo)"),
      language: languageEnum,
      limit: z.number().int().min(1).max(100).optional().describe("Max results per page (default 20, max 100)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
      fields: z.array(z.string()).optional().describe("Limit returned fields per job to reduce response size"),
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/jobs/search", { method: "POST", body: args, tool: "search_existing_tickets", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 2: create_ticket
// ---------------------------------------------------------------------------
server.registerTool(
  "create_ticket",
  {
    title: "Create Ticket / Új jegy létrehozása",
    description: [
      "EN: Create a maintenance ticket. Only customer_name is required.",
      "Fill the rest from the conversation. Do NOT call until you have",
      "the information the worker can provide.",
      "",
      "HU: Új szerviz jegy létrehozása. Csak a customer_name kötelező.",
      "A többit a beszélgetésből töltsd ki. Ne hívd addig, amíg nincs",
      "minden adat a munkatársnál.",
      "",
      "Categorization / kategóriák:",
      "  problem_kategoria: Szoftver hiba | Hardver hiba | Vezérlő hiba |",
      "    Mechanikai hiba | Karbantartas | Telepites | stb.",
      "  sulyossag: alacsony | kozepes | magas | kritikus",
    ].join("\n"),
    inputSchema: {
      customer_name: z.string().describe("Customer or site name (required) — Ügyfél neve"),
      customer_zip: z.string().optional().describe("Postal code / Irányítószám"),
      customer_address: z.string().optional().describe("Address / Cím"),
      customer_phone: z.string().optional().describe("Phone number / Telefon"),
      customer_email: z.string().optional().describe("Email address / E-mail"),
      devices: z.array(z.string()).optional().describe("Device identifiers / Készülék típusok (pl. 'NCT2000', 'TMV-400(10297;M10170)')"),
      reported: z.string().optional().describe("Problem description / Bejelentett hiba"),
      work: z.string().optional().describe("Completed work / Elvégzett munka"),
      technician: z.string().optional().describe("Assigned technician / Dolgozó"),
      reporter: z.string().optional().describe("Who reported the fault / Bejelentő"),
      fault_receiver: z.string().optional().describe("Who received the report / Hibafelvető"),
      payment: z.enum(["fiz", "gar"]).optional().describe("Payment status: fiz=fizetős (paid), gar=garanciális (warranty)"),
      remote_access: z.string().optional().describe("Remote access info / Távoligépelérés"),
      status: z.enum(["open", "closed"]).optional().describe("Initial status (default open / alapértelmezetten nyitott)"),
      problem_kategoria: z.string().optional().describe("Issue category / Hibakategória (pl. 'Szoftver hiba', 'Hardver hiba')"),
      problem_alkategoria: z.string().optional().describe("Subcategory / Alkategória"),
      sulyossag: z.enum(["alacsony", "kozepes", "magas", "kritikus"]).optional().describe("Severity / Súlyosság (alacsony=low, kozepes=medium, magas=high, kritikus=critical)"),
      language: languageEnum,
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call("/v1/tickets/create", { method: "POST", token: WRITE_TOKEN, body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 3: modify_ticket
// ---------------------------------------------------------------------------
server.registerTool(
  "modify_ticket",
  {
    title: "Modify Ticket / Jegy módosítása",
    description: [
      "EN: Update one or more fields on an existing ticket by sorszam.",
      "Omitted fields stay as-is. Returns the updated JobCard.",
      "",
      "HU: Meglévő jegy mezőinek módosítása sorszám alapján.",
      "A nem megadott mezők változatlanok maradnak.",
      "Visszaadja a frissített JobCard-ot.",
    ].join("\n"),
    inputSchema: {
      sorszam: z.string().describe("Ticket sorszam (pl. B26072216)"),
      customer_name: z.string().optional().describe("Corrected customer / Javított ügyfélnév"),
      customer_zip: z.string().optional().describe("Corrected postal code / Javított irányítószám"),
      customer_address: z.string().optional().describe("Corrected address / Javított cím"),
      customer_phone: z.string().optional().describe("Corrected phone / Javított telefon"),
      customer_email: z.string().optional().describe("Corrected email / Javított e-mail"),
      devices: z.array(z.string()).optional().describe("Corrected device list (replaces) / Javított készüléklista (lecseréli a régit)"),
      reported: z.string().optional().describe("Append a note to the problem description / Megjegyzés hozzáfűzése a bejelentett hibához"),
      work: z.string().optional().describe("Append a note to completed work / Megjegyzés hozzáfűzése az elvégzett munkához"),
      technician: z.string().optional().describe("Corrected technician / Javított dolgozó"),
      reporter: z.string().optional().describe("Corrected reporter / Javított bejelentő"),
      fault_receiver: z.string().optional().describe("Corrected fault receiver / Javított hibafelvető"),
      payment: z.enum(["fiz", "gar"]).optional().describe("Corrected payment status / Javított fizetési mód"),
      remote_access: z.string().optional().describe("Corrected remote access / Javított távoligépelérés"),
      status: z.enum(["open", "closed"]).optional().describe("Corrected status / Javított státusz"),
      problem_kategoria: z.string().optional().describe("Corrected issue category / Javított kategória"),
      problem_alkategoria: z.string().optional().describe("Corrected subcategory / Javított alkategória"),
      sulyossag: z.enum(["alacsony", "kozepes", "magas", "kritikus"]).optional().describe("Corrected severity / Javított súlyosság"),
      language: languageEnum,
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call("/v1/tickets/modify", { method: "POST", token: WRITE_TOKEN, body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 4: remove_ticket  (DANGEROUS — kept for parity, but discourage)
// ---------------------------------------------------------------------------
server.registerTool(
  "remove_ticket",
  {
    title: "Remove Ticket (DANGEROUS) / Jegy törlése (VESZÉLYES)",
    description: [
      "EN: PERMANENTLY AND IRREVERSIBLY DELETES a ticket. Prefer close_ticket.",
      "Will be replaced by cancel_ticket (soft delete) in a future phase.",
      "",
      "HU: VÉGLEGES ÉS VISSZAFORDÍTHATATLAN TÖRLÉS. Használd inkább a",
      "close_ticket-et. Egy későbbi fázisban le lesz cserélve cancel_ticket-re.",
    ].join("\n"),
    inputSchema: {
      key: z.number().int().describe("Integer job KEY of the ticket to permanently delete / Törlendő jegy egész KEY azonosítója"),
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call(`/v1/tickets/${args.key}`, { method: "DELETE", token: WRITE_TOKEN });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 5: get_ticket_stats  (default ON: include_evidence)
// ---------------------------------------------------------------------------
server.registerTool(
  "get_ticket_stats",
  {
    title: "Get Ticket Stats / Jegy statisztika",
    description: [
      "EN: ALWAYS USE for any counting, ranking, aggregation, analytics, or",
      "statistical question. Returns pre-counted and sorted results.",
      "",
      "By default each top-N result ALSO returns 1-2 sample ticket",
      "(sorszam + reported-text snippet) under `evidence`, so the answer",
      "can cite real tickets. Set include_evidence=false to suppress.",
      "",
      "HU: MINDIG EZT HASZNÁLD számoláshoz, rangsoroláshoz, aggregációhoz.",
      "Alapértelmezetten minden top-N eredményhez 1-2 minta jegyet is",
      "adunk (sorszám + bejelentett hiba részlet) az `evidence` mezőben,",
      "hogy a válasz valódi jegyekre tudjon hivatkozni. Kikapcsolás:",
      "include_evidence=false.",
      "",
      "Period presets supported: this_month, last_month, this_year,",
      "last_year, YTD, last_30_days, last_90_days, all, and Hungarian",
      "aliases: 'tavaly', 'idén', 'utolsó 30 nap', 'múlt hónap', stb.",
      "",
      "Examples / Példák:",
      "  - 'Melyik ügyfélhez járunk a legtöbbet?' → group_by: customer",
      "  - 'Melyik gép megy legtöbbször tönkre?' → group_by: machine_type",
      "  - 'Mennyi kritikus hiba volt idén?' → group_by: sulyossag, period: this_year",
      "  - 'Melyik vezérlő a legproblémásabb?' → group_by: controller",
    ].join("\n"),
    inputSchema: {
      group_by: z.enum(["customer", "device", "technician", "status", "month", "kategoria", "sulyossag", "machine_type", "controller"]).describe("Dimension to aggregate by / Aggregáció dimenzió"),
      q: z.string().optional().describe("Free text filter (AND-of-tokens) / Szabad szöveges szűrő"),
      customer: z.string().optional().describe("Substring filter on customer / Szűrő ügyfélre"),
      device: z.string().optional().describe("Substring filter on device / Szűrő készülékre"),
      status: z.enum(["open", "closed"]).optional().describe("Filter by status / Szűrő státuszra"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound / Alsó dátumhatár"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound / Felső dátumhatár"),
      period: periodEnum,
      kategoria: z.string().optional().describe("Substring filter on category / Szűrő kategóriára"),
      sulyossag: z.string().optional().describe("Filter on severity / Szűrő súlyosságra"),
      controller: z.string().optional().describe("Substring filter on controller / Szűrő vezérlőre"),
      include_evidence: z.boolean().optional().describe("Attach 1-2 sample tickets per top group (default true) / Minta jegyek csatolása (alapértelmezetten igen)"),
      evidence_per_group: z.number().int().min(0).max(5).optional().describe("Max samples per group (default 2, max 5) / Minta jegyek száma csoportonként"),
      language: languageEnum,
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 50, max 500) / Max eredmény"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/jobs/stats", { method: "POST", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 6: close_ticket
// ---------------------------------------------------------------------------
server.registerTool(
  "close_ticket",
  {
    title: "Close Ticket / Jegy lezárása",
    description: [
      "EN: Close a ticket by integer key. Optionally provide solution text.",
      "HU: Jegy lezárása egész kulccsal. Opcionálisan megoldás szöveget is",
      "megadhatsz, ami az ELVÉGZETT MUNKA mezőbe kerül.",
    ].join("\n"),
    inputSchema: {
      key: z.number().int().describe("Integer job KEY to close / Lezárandó jegy egész kulcsa"),
      text: z.string().optional().describe("Solution description / Megoldás leírása (mit csináltál)"),
      author: z.string().optional().describe("Who performed the fix / Ki végezte a javítást"),
      language: languageEnum,
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const body: Record<string, unknown> = {};
      if (args.text) body.text = args.text;
      if (args.author) body.author = args.author;
      const data = await call(`/v1/tickets/${args.key}/close`, { method: "POST", token: WRITE_TOKEN, body });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 7: get_categories
// ---------------------------------------------------------------------------
server.registerTool(
  "get_categories",
  {
    title: "Get Categories / Kategóriák listája",
    description: [
      "EN: List all available issue categories. Use before assigning a",
      "category to a ticket.",
      "",
      "HU: Elérhető hibakategóriák listája. Használd mielőtt kategóriát",
      "rendelsz egy jegyhez.",
    ].join("\n"),
    inputSchema: { language: languageEnum },
  },
  async (_args) => {
    try {
      const data = await call("/v1/categories");
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 8: get_tags
// ---------------------------------------------------------------------------
server.registerTool(
  "get_tags",
  {
    title: "Get Tags / Cimkék listája",
    description: [
      "EN: List all available tags that can be attached to tickets.",
      "HU: Elérhető címkék listája, amiket jegyekhez lehet rendelni.",
    ].join("\n"),
    inputSchema: { language: languageEnum },
  },
  async (_args) => {
    try {
      const data = await call("/v1/tags");
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 9: add_ticket_tag
// ---------------------------------------------------------------------------
server.registerTool(
  "add_ticket_tag",
  {
    title: "Add Ticket Tag / Cimke hozzáadása",
    description: [
      "EN: Add a tag to a ticket by integer key. The tag is created if",
      "it doesn't exist.",
      "HU: Cimke hozzáadása egy jegyhez. Ha a cimke nem létezik, létrejön.",
    ].join("\n"),
    inputSchema: {
      key: z.number().int().describe("Integer job KEY / Jegy egész kulcsa"),
      nev: z.string().describe("Tag name (created if new) / Cimke neve"),
      language: languageEnum,
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call(`/v1/tickets/${args.key}/tags`, {
        method: "POST",
        token: WRITE_TOKEN,
        body: { nev: args.nev },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 10: set_ticket_category
// ---------------------------------------------------------------------------
server.registerTool(
  "set_ticket_category",
  {
    title: "Set Ticket Category / Jegy kategória beállítása",
    description: [
      "EN: Set the primary issue category on a ticket. Use modify_ticket",
      "to also update severity and subcategory.",
      "HU: Elsődleges kategória beállítása egy jegyhez. Súlyosság és",
      "alkategória módosításához használd a modify_ticket-et.",
    ].join("\n"),
    inputSchema: {
      sorszam: z.string().describe("Ticket sorszam (pl. B26072216)"),
      problem_kategoria: z.string().describe("Category name (pl. 'Szoftver hiba')"),
      language: languageEnum,
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call("/v1/tickets/modify", {
        method: "POST",
        token: WRITE_TOKEN,
        body: { sorszam: args.sorszam, problem_kategoria: args.problem_kategoria },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 11: set_ticket_severity
// ---------------------------------------------------------------------------
server.registerTool(
  "set_ticket_severity",
  {
    title: "Set Ticket Severity / Jegy súlyosság beállítása",
    description: [
      "EN: Set the severity on a ticket. Use modify_ticket to also update",
      "category and other fields.",
      "HU: Súlyosság beállítása egy jegyhez. Kategória és egyéb mezők",
      "módosításához használd a modify_ticket-et.",
    ].join("\n"),
    inputSchema: {
      sorszam: z.string().describe("Ticket sorszam"),
      sulyossag: z.enum(["alacsony", "kozepes", "magas", "kritikus"]).describe("Severity / Súlyosság"),
      language: languageEnum,
    },
  },
  async (args) => {
    if (!WRITE_TOKEN) {
      return { content: [{ type: "text", text: "Write token (CMMS_API_TOKEN_WRITE) is not configured." }], isError: true };
    }
    try {
      const data = await call("/v1/tickets/modify", {
        method: "POST",
        token: WRITE_TOKEN,
        body: { sorszam: args.sorszam, sulyossag: args.sulyossag },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 12: search_by_category
// ---------------------------------------------------------------------------
server.registerTool(
  "search_by_category",
  {
    title: "Search by Category / Keresés kategória szerint",
    description: [
      "EN: Fast search for tickets by issue category and optional filters.",
      "Much faster than free-text for category-based queries. Consider using",
      "search_existing_tickets with kategoria=... instead (broader support).",
      "",
      "HU: Gyors keresés kategória és egyéb szűrők alapján. Az általánosabb",
      "search_existing_tickets kategoria=... paraméterrel is használható.",
    ].join("\n"),
    inputSchema: {
      kategoria: z.string().describe("Issue category / Hibakategória (pl. 'Szoftver hiba')"),
      status: z.enum(["open", "closed"]).optional().describe("Filter by status / Szűrő státuszra"),
      device: z.string().optional().describe("Substring filter on device / Szűrő készülékre"),
      customer: z.string().optional().describe("Substring filter on customer / Szűrő ügyfélre"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound / Alsó dátumhatár"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound / Felső dátumhatár"),
      period: periodEnum,
      language: languageEnum,
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20) / Max eredmény"),
      fields: z.array(z.string()).optional().describe("Limit returned fields / Visszaadott mezők korlátozása"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/jobs/search", {
        method: "POST",
        body: { ...args, q: undefined },
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 13: find_recurring_problems
// ---------------------------------------------------------------------------
server.registerTool(
  "find_recurring_problems",
  {
    title: "Find Recurring Problems / Visszatérő hibák keresése",
    description: [
      "EN: Find groups of 2+ tickets that share a root-cause signature.",
      "USE FOR: 'what problem kept coming back?', 'which job did we go out",
      "to most?', 'was this issue fixed before?'.",
      "DO NOT USE for raw counts (use get_ticket_stats).",
      "",
      "HU: 2+ jegyet összekötő visszatérő hibacsoportok keresése.",
      "HASZNÁLD: 'mi jött vissza újra?', 'melyik munkához jártunk ki",
      "legtöbbször?', 'volt-e már ilyen hiba?'.",
      "NE HASZNÁLD nyers számolásra — ott get_ticket_stats.",
      "",
      "Scope (milyen szigorúan csoportosítson):",
      "  narrow: minden signature mező egyezzen (ügyfél+gép+vezérlő+...)",
      "  broad (default): gép + vezérlő + kategória kell",
      "  broadest: csak vezérlő + kategória",
      "",
      "Period preset-ek elfogadottak (period=...).",
    ].join("\n"),
    inputSchema: {
      customer: z.string().optional().describe("Filter to a specific customer (narrow scope) / Szűrő ügyfélre"),
      machine: z.string().optional().describe("Filter to a machine type (pl. 'TMV-400') / Szűrő géptípusra"),
      controller: z.string().optional().describe("Filter to a controller (pl. 'NCT104') / Szűrő vezérlőre"),
      software: z.string().optional().describe("Filter to a software version (pl. 'SW-1.039') / Szűrő szoftver verzióra"),
      hardware: z.string().optional().describe("Filter to a hardware variant (pl. 'HW:int') / Szűrő hardver variánsra"),
      kategoria: z.string().optional().describe("Filter to a problem category / Szűrő kategóriára"),
      alkategoria: z.string().optional().describe("Filter to a subcategory / Szűrő alkategóriára"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound / Alsó dátumhatár"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound / Felső dátumhatár"),
      period: periodEnum,
      scope: z.enum(["narrow", "broad", "broadest"]).optional().describe("Signature strictness (default 'broad') / Szigorúság"),
      min_visits: z.number().int().min(2).optional().describe("Minimum visits per cluster (default 2) / Minimum látogatás klaszterenként"),
      limit: z.number().int().min(1).max(100).optional().describe("Max clusters to return (default 20) / Max klaszter"),
      language: languageEnum,
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/jobs/recurring-problems", { method: "POST", body: args, tool: "find_recurring_problems", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 14: get_problem_cluster
// ---------------------------------------------------------------------------
server.registerTool(
  "get_problem_cluster",
  {
    title: "Get Problem Cluster / Probléma klaszter lekérése",
    description: [
      "EN: Get the full ordered ticket list for a single recurring-problem",
      "cluster, including visit_count, technicians, first_seen, last_seen,",
      "and handoffs (when tech A tried but tech B later fixed it).",
      "",
      "HU: Egy konkrét visszatérő hibacsoport összes jegyének listája,",
      "látogatás-számmal, technikusokkal, first_seen/last_seen dátumokkal,",
      "és a technikus-váltásokkal (handoffs).",
    ].join("\n"),
    inputSchema: {
      customer: z.string().optional().describe("Customer name (narrow scope) / Ügyfél neve"),
      machine: z.string().optional().describe("Machine type / Géptípus"),
      controller: z.string().optional().describe("Controller / Vezérlő"),
      software: z.string().optional().describe("Software version / Szoftver verzió"),
      hardware: z.string().optional().describe("Hardware variant / Hardver variáns"),
      kategoria: z.string().optional().describe("Problem category / Kategória"),
      alkategoria: z.string().optional().describe("Problem subcategory / Alkategória"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound / Alsó dátumhatár"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound / Felső dátumhatár"),
      period: periodEnum,
      scope: z.enum(["narrow", "broad", "broadest"]).optional().describe("Signature strictness (default 'broad') / Szigorúság"),
      limit: z.number().int().min(1).max(500).optional().describe("Max tickets to return (default 50) / Max jegy"),
      language: languageEnum,
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/jobs/recurring-problems/cluster", { method: "POST", body: args, tool: "get_problem_cluster", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tools 15-18: Integrated archive (szerviz belső, SZÉV, telephely, AiS motor)
// ---------------------------------------------------------------------------
server.registerTool(
  "search_serviz_belso",
  {
    title: "Search Internal Service Tickets / Belső szerviz jegyek keresése",
    description: [
      "EN: Search the internal workshop service-ticket archive (2008-now).",
      "Separate from search_existing_tickets. Use for 'did we see this",
      "fault internally?', '2018 internal service tickets on TMV-400', etc.",
      "",
      "HU: Belső szerviz archívum keresése (2008-tól). Különálló a",
      "search_existing_tickets-től. Használd: 'volt már ilyen belső hibánk?',",
      "'TMV-400 belső szerviz jegyek 2018-ban', stb.",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text (FTS5) / Szabad szöveg"),
      j_szam: z.string().optional().describe("Substring match on J-sorszam (pl. 'J00001')"),
      cegnev: z.string().optional().describe("Substring match on customer / Ügyfélre szűrő"),
      eszkoz: z.string().optional().describe("Substring match on device type / Készülékre szűrő"),
      dolgozo: z.string().optional().describe("Substring match on technician / Dolgozóra szűrő"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound / Alsó dátumhatár"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound / Felső dátumhatár"),
      source_period: z.string().optional().describe("Source file tag (pl. '2008-2020', '2020-taksony')"),
      language: languageEnum,
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50, max 200) / Max eredmény"),
      offset: z.number().int().min(0).optional().describe("Pagination offset / Lapozás"),
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/integration/serviz/search", { method: "GET", body: args, tool: "search_serviz_belso", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "get_serviz_ticket",
  {
    title: "Get Internal Service Ticket by J-sorszam",
    description: [
      "EN: Fetch a single internal service ticket by J-sorszam.",
      "HU: Egy konkrét belső szerviz jegy lekérése J-sorszám alapján.",
    ].join("\n"),
    inputSchema: {
      j: z.string().describe("J-sorszam, pl. 'J00001'"),
      language: languageEnum,
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/integration/serviz/by-j-szam", { method: "GET", body: args, tool: "get_serviz_ticket", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "search_szev_igeny",
  {
    title: "Search SZÉV Igény / Belső anyagrendelés keresése",
    description: [
      "EN: Search the internal procurement / service requisition log",
      "(2019-now). Bearings, parts, external services.",
      "USE FOR: 'what bearings did we order for X in 2024?', 'TMV-400",
      "requisitions', '2025 SZÉV from MVM Paksi'.",
      "",
      "HU: Belső anyagrendelés / szerviz igénylések keresése (2019-től).",
      "Csapágyak, alkatrészek, külső szolgáltatások.",
      "HASZNÁLD: 'milyen csapágyat rendeltünk X-nek 2024-ben?',",
      "'TMV-400 anyagrendelések', '2025-ös SZÉV MVM Paksi-tól'.",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text (FTS5) / Szabad szöveg"),
      megrendelo: z.string().optional().describe("Substring match on customer / Ügyfélre szűrő"),
      geptipus: z.string().optional().describe("Substring match on machine type / Géptípusra szűrő"),
      munkaszam: z.string().optional().describe("Substring match on munkaszam"),
      felelos: z.string().optional().describe("Substring match on responsible person / Felelősre szűrő"),
      year: z.number().int().optional().describe("Filter by year (2019-2026) / Szűrő évre"),
      language: languageEnum,
      limit: z.number().int().min(1).max(200).optional().describe("Max results / Max eredmény"),
      offset: z.number().int().min(0).optional().describe("Pagination offset / Lapozás"),
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/integration/szev/search", { method: "GET", body: args, tool: "search_szev_igeny", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "search_telephely_munka",
  {
    title: "Search Telephelyi Munkák / Telephelyi munkák keresése",
    description: [
      "EN: Search the in-house workshop job log. Parts brought back to the",
      "depot for repair/rebuild, plus on-site (TH) repairs.",
      "USE FOR: 'did we ever rebuild this build element?', 'all telephely",
      "jobs for M14066', '2020 telephely with szögfej'.",
      "",
      "HU: Telephelyi munkák keresése. Telephelyre visszahozott alkatrészek",
      "felújítása, helyszíni (TH) javítások.",
      "HASZNÁLD: 'felújítottunk már ilyen építőelemet?', 'M14066 minden",
      "telephelyi munka', '2020-as telephelyi szögfejjel'.",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text (FTS5) / Szabad szöveg"),
      megrendelo: z.string().optional().describe("Substring match on customer / Ügyfélre szűrő"),
      geptipus: z.string().optional().describe("Substring match on machine type / Géptípusra szűrő"),
      munkaszam: z.string().optional().describe("Substring match on munkaszam"),
      year: z.number().int().optional().describe("Filter by year / Szűrő évre"),
      language: languageEnum,
      limit: z.number().int().min(1).max(200).optional().describe("Max results / Max eredmény"),
      offset: z.number().int().min(0).optional().describe("Pagination offset / Lapozás"),
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/integration/telephely/search", { method: "GET", body: args, tool: "search_telephely_munka", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "search_ais_motor_inventory",
  {
    title: "Search Bad-AiS-Motor Inventory / Selejt motor raktár",
    description: [
      "EN: List the contents of the bad AiS motor inventory. 50+ motors of",
      "various types (AiS100, AiS132, Baumüller, Solpower) tracked with",
      "their original machine, failure mode, remaining parts, and planned",
      "disposition.",
      "USE FOR: 'do we have a spare AiS100 from M16119?', 'list all",
      "zárlatos (shorted) motors', 'motors returned from customer X'.",
      "",
      "HU: Selejt AiS motor raktár listázása. 50+ motor (AiS100, AiS132,",
      "Baumüller, Solpower) eredeti géppel, hibaokkal, maradék alkatrészekkel.",
      "HASZNÁLD: 'van pótmotorunk M16119-ről?', 'melyik zárlatos motor van",
      "raktáron?', 'X ügyféltől visszajött motorok'.",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text (FTS5) / Szabad szöveg"),
      tipus: z.string().optional().describe("Exact match on motor type (pl. 'AiS100', 'AiS132')"),
      gep: z.string().optional().describe("Substring match on original machine ID / Eredeti gép azonosítóra szűrő"),
      language: languageEnum,
      limit: z.number().int().min(1).max(200).optional().describe("Max results / Max eredmény"),
      offset: z.number().int().min(0).optional().describe("Pagination offset / Lapozás"),
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/integration/ais/search", { method: "GET", body: args, tool: "search_ais_motor_inventory", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "get_integration_stats",
  {
    title: "Integration Stats / Integráció statisztika",
    description: [
      "EN: Aggregate counts across the integrated CMMS data: SZÉV by year,",
      "serviz by source period, top motor types in the bad-AiS inventory.",
      "HU: Integrált CMMS adat aggregátumok: SZÉV éves bontás, szerviz",
      "forrás-időszak szerinti bontás, top motor típusok a raktárban.",
    ].join("\n"),
    inputSchema: { language: languageEnum },
  },
  async () => {
    try {
      const data = await call("/v1/integration/stats", { method: "GET" });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 19: search_existing_tickets (legacy alias — calls /v1/jobs/search)
// ---------------------------------------------------------------------------
// Kept for compatibility with the original MCP tool surface. Newer
// prompts should prefer `search_tickets` or `answer_question`.
server.registerTool(
  "search_existing_tickets",
  {
    title: "Search Existing Tickets / Meglévő jegyek keresése",
    description: [
      "EN: Search for existing maintenance tickets by free text or filters.",
      "Returns total count and the matching jobs. Use `q` for free text,",
      "`customer`, `device`, `status`, `kategoria` etc. for filters.",
      "Bilingual period aliases accepted (e.g. 'tavaly', 'utolsó 30 nap').",
      "",
      "HU: Meglévő szerviz jegyek keresése szabad szöveggel vagy szűrőkkel.",
      "Visszaadja a találatok számát és a jegyeket. Szűrők: q, customer,",
      "device, status, kategoria, stb. Magyar időszak aliasok is elfogadottak.",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free text search (AND-of-tokens, diacritic-folded)"),
      customer: z.string().optional().describe("Substring match on customer name"),
      device: z.string().optional().describe("Substring match on device raw or model"),
      status: z.enum(["open", "closed"]).optional().describe("Filter by job status"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound"),
      period: periodEnum,
      notes_contains: z.string().optional().describe("Substring match on note text body"),
      kategoria: z.string().optional().describe("Substring match on issue category"),
      sulyossag: z.string().optional().describe("Exact match on severity"),
      controller: z.string().optional().describe("Substring match on device controller"),
      language: languageEnum,
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/jobs/search", { method: "POST", body: args, tool: "search_existing_tickets", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 20: search_tickets (Phase 1 unified search with auto-extracted params)
// ---------------------------------------------------------------------------
server.registerTool(
  "search_tickets",
  {
    title: "Search Tickets (unified) / Jegyek keresése (egységes)",
    description: [
      "EN: Unified search across all CMMS tickets. Auto-extracts customer,",
      "device, sorszam, and period from the `q` parameter, then applies any",
      "explicit filters. Use this for natural-language queries like",
      "'tavalyi ANDRITZ TMV-400 hibák'.",
      "",
      "HU: Egységes keresés az összes CMMS jegy között. A `q` paraméterből",
      "automatikusan kinyeri az ügyfelet, gépet, sorszámot és időszakot, majd",
      "alkalmazza a megadott szűrőket.",
    ].join("\n"),
    inputSchema: {
      q: z.string().optional().describe("Free-text query with auto-extracted filters"),
      customer: z.string().optional().describe("Explicit customer filter"),
      device: z.string().optional().describe("Explicit device filter"),
      sorszam: z.string().optional().describe("Explicit sorszam filter"),
      status: z.enum(["open", "closed"]).optional().describe("Filter by job status"),
      kategoria: z.string().optional().describe("Substring match on issue category"),
      kategoria_inferred: z.string().optional().describe("Substring match on inferred category"),
      sulyossag_inferred: z.enum(["alacsony", "kozepes", "magas", "kritikus"]).optional().describe("Filter by inferred severity"),
      date_from: z.string().optional().describe("YYYY-MM-DD lower bound"),
      date_to: z.string().optional().describe("YYYY-MM-DD upper bound"),
      period: periodEnum,
      include_evidence: z.boolean().optional().describe("Include sample sorszam+snippet evidence (default true)"),
      language: languageEnum,
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/jobs/search", { method: "POST", body: args, tool: "search_tickets", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 21: get_failure_rates (Phase 2 — from statisztika table)
// ---------------------------------------------------------------------------
server.registerTool(
  "get_failure_rates",
  {
    title: "Get Failure Rates / Meghibásodási arányok",
    description: [
      "EN: Per-model failure rates from the statisztika table. Use for",
      "'melyik géptípus a legmegbízhatatlanabb?' / 'failure rate of TMV'.",
      "",
      "HU: Géptípus szerinti meghibásodási arányok a statisztika táblából.",
      "Használd: 'melyik gép romlik el a legtöbbször?' / 'TMV meghibásodási arány'.",
    ].join("\n"),
    inputSchema: {
      period: periodEnum,
      model_filter: z.string().optional().describe("Substring match on model name (e.g. 'TMV', 'DPB')"),
      language: languageEnum,
      limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 50)"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/integration/failure-rates", { method: "POST", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 22: find_spare_motor (Phase 2 — AiS stock with match_score)
// ---------------------------------------------------------------------------
server.registerTool(
  "find_spare_motor",
  {
    title: "Find Spare Motor / Tartalék motor keresése",
    description: [
      "EN: Find a replacement motor from the bad-AiS stock for a given",
      "machine + motor type. Returns candidates with a `match_score` 0..1",
      "indicating how well each motor fits the request.",
      "",
      "HU: Csere motor keresése a raktáron lévő AiS motorok közül egy adott",
      "gép + motor típushoz. A találatok `match_score` 0..1 értéket kapnak,",
      "ami megmutatja, mennyire illik a kérésre.",
    ].join("\n"),
    inputSchema: {
      serial_number: z.string().optional().describe("Machine serial number (e.g. 'M10170')"),
      motor_type: z.string().optional().describe("Motor type to find (e.g. 'AiS100')"),
      problem: z.string().optional().describe("Free-text problem description for fuzzy matching"),
      language: languageEnum,
      limit: z.number().int().min(1).max(20).optional().describe("Max candidates (default 5)"),
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/integration/spare-motor", { method: "POST", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 23: search_customers (Phase 2)
// ---------------------------------------------------------------------------
server.registerTool(
  "search_customers",
  {
    title: "Search Customers / Ügyfelek keresése",
    description: [
      "EN: Substring search for customer names. Returns each match with",
      "a per-customer ticket count. Use for disambiguating customer names",
      "before searching their tickets.",
      "",
      "HU: Ügyfél nevek részleges keresése. Visszaadja a találatokat és",
      "az egyes ügyfelekhez tartozó jegyek számát. Használd az ügyfélnév",
      "egyértelműsítéséhez, mielőtt a jegyeit keresed.",
    ].join("\n"),
    inputSchema: {
      q: z.string().describe("Substring to search for in customer name"),
      min_tickets: z.number().int().min(0).optional().describe("Minimum ticket count (default 0)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max customers (default 20)"),
      language: languageEnum,
    },
  },
  async (args) => {
    try {
      const q = encodeURIComponent(args.q);
      const minT = args.min_tickets ?? 0;
      const lim = args.limit ?? 20;
      const data = await call(`/v1/customers/search?q=${q}&min_tickets=${minT}&limit=${lim}`, { method: "GET" });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 24: customer_canonical (Phase 2 — alias folding)
// ---------------------------------------------------------------------------
server.registerTool(
  "customer_canonical",
  {
    title: "Customer Canonical / Ügyfél kanonizálás",
    description: [
      "EN: Group spelling variants of the same real customer. Given a",
      "substring, returns the canonical group name and a list of spelling",
      "variants with per-variant ticket counts. 327 ANDRITZ KFT. rows can",
      "fold down to one canonical group.",
      "",
      "HU: Azonos valós ügyfél írásváltozatainak csoportosítása. A kapott",
      "részletes szövegből visszaadja a kanonikus csoportnevet és az írásváltozatokat",
      "a jegyek számával együtt.",
    ].join("\n"),
    inputSchema: {
      q: z.string().describe("Substring to canonicalize (e.g. 'ANDRITZ')"),
      min_tickets: z.number().int().min(1).optional().describe("Minimum ticket count to include (default 1)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max variants to return (default 10)"),
      language: languageEnum,
    },
  },
  async (args) => {
    try {
      const data = await call("/v1/customers/canonical", { method: "POST", body: args });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 25: find_related_tickets (Phase 4 — cross-database timeline)
// ---------------------------------------------------------------------------
server.registerTool(
  "find_related_tickets",
  {
    title: "Find Related Tickets / Kapcsolódó jegyek keresése",
    description: [
      "EN: Find a cross-database timeline of entries related to a seed",
      "ticket (by sorszam) or a customer+device combo. Searches main CMMS,",
      "serviz_belso, szev_igeny, and telephely_munka. Returns a chronological",
      "list with `relevance` score per entry.",
      "",
      "USE FOR: 'mi volt még akkor?', 'kapcsolódó bejegyzések', 'show me",
      "everything related to this case'.",
      "",
      "HU: Kereszttáblás időrend a seed jegyhez (sorszam) vagy ügyfél+gép",
      "kombinációhoz. Keres a fő CMMS, serviz_belso, szev_igeny és",
      "telephely_munka táblákban. Visszaadja az időrendi listát `relevance`",
      "pontszámmal minden bejegyzésnél.",
      "",
      "HASZNÁLD: 'mi volt még akkor?', 'kapcsolódó bejegyzések',",
      "'mutasd mindent ami ehhez az esethez tartozik'.",
    ].join("\n"),
    inputSchema: {
      sorszam: z.string().optional().describe("Seed sorszam (e.g. 'B-2024/0891')"),
      customer: z.string().optional().describe("Seed customer (substring match)"),
      device: z.string().optional().describe("Seed device (e.g. 'TMV-400')"),
      window_days: z.number().int().min(1).max(730).optional().describe("Date proximity window in days (default 180)"),
      limit: z.number().int().min(1).max(500).optional().describe("Max entries (default 50)"),
      language: languageEnum,
    },
  },
  async (args) => {
    try {
      const data = await guardedCall("/v1/related", { method: "POST", body: args, tool: "find_related_tickets", args, language: args.language });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 26: find_linkage (Phase 5b — sorszam cross-reference graph)
// ---------------------------------------------------------------------------
// Scans every note body for explicit mentions of other sorszams and
// builds a forward+reverse index on startup. Lets the LLM answer:
//   - "melyik munkához történt a legtöbb kiszállás?" → top_hubs
//   - "mi hivatkozik erre a ticketre?" → referenced_by
//   - "ez a ticket mire hivatkozik?" → references
server.registerTool(
  "find_linkage",
  {
    title: "Find Ticket Linkage / Jegy hivatkozások keresése",
    description: [
      "EN: Look up sorszam cross-references found in note bodies.",
      "USE direction='top_hubs' for 'melyik munkához történt a legtöbb",
      "kiszállás?'. direction='referenced_by' for 'mi hivatkozik erre?'. ",
      "direction='references' for 'ez a ticket hivatkozik valamire?'.",
      "direction='stats' for the global total.",
      "",
      "HU: Jegy-egymásra hivatkozások keresése a jegyzet törzsekből.",
      "HASZNÁLD direction='top_hubs' -t 'melyik munkához történt a legtöbb",
      "kiszállás?' kérdésre. direction='referenced_by' -t 'mi hivatkozik",
      "erre a ticketre?' kérdésre. direction='references' -t 'ez a ticket",
      "mire hivatkozik?' kérdésre. direction='stats' a globális összesítéshez.",
    ].join("\n"),
    inputSchema: {
      direction: z.enum(["stats", "top_hubs", "referenced_by", "references"]).describe("What to look up / Mit nézzen ki"),
      sorszam: z.string().optional().describe("Sorszam to look up (required for referenced_by / references)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
    },
  },
  async (args) => {
    try {
      const params = new URLSearchParams();
      params.set("direction", args.direction);
      if (args.sorszam) params.set("sorszam", args.sorszam);
      if (args.limit) params.set("limit", String(args.limit));
      const data = await call(`/v1/jobs/linkage?${params.toString()}`);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
);

} // end registerTools

// --- Start: stdio transport ---

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cmms-api MCP server running on stdio");
}

// --- Start: HTTP transport (Streamable HTTP for remote/tunnel clients) ---

async function startHttp() {
  // One transport per session (stateful). MCP clients send initialize,
  // we mint a session ID, and handle subsequent requests on the same
  // transport until DELETE. Each session needs its own McpServer instance
  // because McpServer.connect() can only be called once per server.
  type Session = {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
  };
  const sessions = new Map<string, Session>();

  function newSession(): WebStandardStreamableHTTPServerTransport {
    const server = createServer();
    const t = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport: t, server });
        console.error(`[mcp] session open: ${sid}`);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        console.error(`[mcp] session closed: ${sid}`);
      },
    });
    t.onclose = () => {
      if (t.sessionId) sessions.delete(t.sessionId);
    };
    server.connect(t).catch((e) => {
      console.error(`[mcp] server.connect error:`, e);
    });
    return t;
  }

  const handler = async (req: Request): Promise<Response> => {
    // Optional bearer auth (recommended when exposed via a tunnel).
    if (HTTP_BEARER) {
      const auth = req.headers.get("authorization") ?? "";
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m || m[1] !== HTTP_BEARER) {
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
    }
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, transport: "http" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname !== "/mcp") {
      return new Response("not found", { status: 404 });
    }
    const sid = req.headers.get("mcp-session-id") ?? undefined;
    const transport = sid && sessions.has(sid)
      ? sessions.get(sid)!.transport
      : newSession();
    return transport.handleRequest(req);
  };

  const server = Bun.serve({
    port: HTTP_PORT,
    hostname: HTTP_HOST,
    fetch: handler,
  });
  console.error(`cmms-api MCP server running on http://${HTTP_HOST}:${HTTP_PORT}/mcp`);
  if (HTTP_BEARER) {
    console.error(`[mcp] bearer auth enabled (token: ${HTTP_BEARER.slice(0, 8)}...)`);
  }
}

if (TRANSPORT === "http") {
  await startHttp();
} else {
  await startStdio();
}
